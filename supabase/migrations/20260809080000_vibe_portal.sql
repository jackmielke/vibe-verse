-- The portal: games somebody else wrote, paying out real Vibey Coins.
--
-- Every world in the vibeverse so far lives in this repository, which means
-- every world costs Jack a code review and a deploy. That does not scale to
-- "my friend made a game and wants it in the arcade", and it does not scale
-- to an eight-year-old with a Scratch-shaped idea. The portal is the answer:
-- a game hosted anywhere, loaded in an iframe, allowed to pay its players.
--
-- The single load-bearing rule, which the rest of the schema exists to
-- enforce:
--
--   **A game never mints. It spends an allowance the vibeverse holds.**
--
-- A registered game is handed a budget — per award, per session, per player
-- per day, and across all players per day. It cannot exceed any of them, and
-- exceeding one is not an error condition to be handled: it is the ceiling
-- doing its job, and the player is simply told they have earned what today's
-- game had to give. That turns "can we trust this developer?" — a question
-- with no good answer — into "what is the most this game can cost us today?",
-- which is a number in a column.
--
-- Where the trust boundary actually sits: a third-party game runs in a
-- sandboxed frame on its OWN origin, so it cannot read our cookies, our
-- localStorage or our Supabase session — the browser will not let it. It
-- talks to us through `postMessage` and nothing else. The session id below —
-- the only capability that can move money — is created by our page, held by
-- our page, and never posted into the frame. So a game asks for an award; it
-- can never take one.
--
-- Two things this does NOT defend against, stated plainly so nobody is
-- surprised later:
--
--   * A row with `origin = 'self'` is served from our own origin and IS
--     inside the fence — it can read our localStorage like any script we
--     ship. That is what `self` means, and it is why it is only ever correct
--     for a game in this repository. See the note on that column.
--   * A *player* with the browser console open can call the award endpoint
--     for their own session and claim a score they did not get. That is the
--     same deal the arcade cabinets already make. The budgets bound what
--     cheating is worth, and the ledger records who did it.

-- ---------------------------------------------------------------------------
-- The register: which games are allowed in, and for how much
-- ---------------------------------------------------------------------------

create table if not exists public.vibe_portal_games (
  -- The route. `/play/<slug>`. Lowercase, url-safe, never reused.
  slug            text primary key
                    check (slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'),

  title           text not null,
  tagline         text,
  author          text,
  author_url      text,

  -- Loaded into the iframe, verbatim. Either an absolute https url (a real
  -- third-party game) or a root-relative path (one we serve ourselves, which
  -- is how the reference game ships). http is refused: the browser blocks a
  -- mixed-content frame anyway, and failing here gives a better error than a
  -- silently blank rectangle.
  embed_url       text not null check (embed_url ~ '^(https://|/)'),

  -- The exact origin permitted to talk to us, e.g. `https://leo.itch.io`.
  -- Stored separately from embed_url rather than derived at runtime: a game
  -- that redirects its frame elsewhere must not inherit the permission, and
  -- the value the host compares against should be the one a human approved.
  --
  -- The literal `self` means "same origin as the vibeverse" — only correct
  -- for a game in this repository, because a same-origin frame is inside the
  -- fence rather than outside it. The host resolves it to
  -- `window.location.origin` so dev and prod need no separate rows.
  origin          text not null check (origin = 'self' or origin ~ '^https://[a-z0-9.-]+(:[0-9]+)?$'),

  -- The four ceilings. Every one is checked on every award.
  max_award       integer not null default 25   check (max_award      between 1 and 500),
  session_budget  integer not null default 80   check (session_budget between 1 and 2000),
  player_daily    integer not null default 150  check (player_daily   between 1 and 5000),
  daily_budget    integer not null default 2000 check (daily_budget   between 1 and 100000),

  -- Off by default is the wrong default for a table Jack edits by hand, and
  -- the right one for a table anybody can eventually submit to. It is on,
  -- because today the only way in is a migration; flip this when the submit
  -- form lands.
  active          boolean not null default true,

  -- Free text. "jack, 9 aug — played it, it's a real game."
  note            text,
  created_at      timestamptz not null default now()
);

alter table public.vibe_portal_games enable row level security;

-- Readable by everyone: the host page needs the embed url and the origin to
-- render the frame at all, and the budgets are worth showing a player up
-- front ("this game has 40 left to give today") rather than hiding until
-- they hit the wall.
drop policy if exists "portal games readable by all" on public.vibe_portal_games;
create policy "portal games readable by all"
  on public.vibe_portal_games for select
  using (true);

-- No insert/update/delete policy, deliberately. The service role bypasses
-- RLS; everybody else, including a signed-in Jack, cannot rewrite a budget
-- from the browser console.

comment on table public.vibe_portal_games is
  'Third-party games allowed to pay out Vibey Coins, with the four budgets that bound them. Written only by migrations and the service role.';

-- ---------------------------------------------------------------------------
-- The sessions: one visit to one game, and what it has paid so far
-- ---------------------------------------------------------------------------

create table if not exists public.vibe_portal_sessions (
  -- This id IS the capability to spend the game's allowance. It is minted by
  -- `vibe-portal open`, held only by the vibeverse's own page, and never
  -- posted into the game's frame.
  id             uuid primary key default gen_random_uuid(),
  slug           text not null references public.vibe_portal_games(slug) on delete cascade,

  -- 'user' only for now — an agent playing a third-party game is a fun idea
  -- and not one worth leaving a hole for.
  owner_kind     text not null default 'user' check (owner_kind = 'user'),
  owner_ref      text not null,

  -- The UTC day the session belongs to, fixed at open. Daily budgets sum
  -- over this column, so a session that straddles midnight cannot spend
  -- tomorrow's allowance on yesterday's arithmetic — it simply expires and
  -- the host opens a fresh one. Cheaper and more exact than summing a
  -- timestamp range, and it makes the daily rollover a visible thing rather
  -- than a rounding error.
  day            date not null default (now() at time zone 'utc')::date,

  awarded        integer not null default 0,
  awards         integer not null default 0,

  opened_at      timestamptz not null default now(),
  last_award_at  timestamptz,
  closed_at      timestamptz
);

alter table public.vibe_portal_sessions enable row level security;

-- No select policy either. There is nothing here a player needs that the
-- award response does not already return, and a readable session id is a
-- spendable one.

-- The two sums every award does: what this game has paid today across
-- everyone, and what it has paid THIS player today.
create index if not exists vibe_portal_sessions_day_idx
  on public.vibe_portal_sessions (slug, day);
create index if not exists vibe_portal_sessions_player_day_idx
  on public.vibe_portal_sessions (owner_ref, slug, day);

comment on table public.vibe_portal_sessions is
  'One visit to one portal game. The id is a bearer capability for that game''s allowance and never enters the game frame.';

comment on column public.vibe_portal_sessions.day is
  'UTC day fixed at open. Daily budgets group by it, so a session cannot straddle midnight into tomorrow''s allowance.';

-- ---------------------------------------------------------------------------
-- The first game in
-- ---------------------------------------------------------------------------
--
-- Coin Drop lives in this repository, which makes it the one row that may use
-- `origin: 'self'` — see the note on that column. It is here so the portal is
-- never an empty shelf, and so the SDK docs have something honest to point at:
-- it goes through the same sandbox, the same bridge and the same budgets as
-- anybody else's game, with no special access at all.
insert into public.vibe_portal_games
  (slug, title, tagline, author, embed_url, origin,
   max_award, session_budget, player_daily, daily_budget, note)
values
  ('coin-drop', 'Coin Drop', 'Catch what falls. Keep what you catch.', 'The Vibeverse',
   '/games/coin-drop/index.html', 'self', 12, 60, 120, 1500,
   'The reference game. Two hundred lines of plain HTML, no build step.')
on conflict (slug) do nothing;
