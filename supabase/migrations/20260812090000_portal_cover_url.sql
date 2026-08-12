-- A picture for every game on the shelf.
--
-- The portal has stored a title, a tagline, an author and a licence since it
-- existed, and never a cover. So the arcade drew a coloured rectangle with a
-- name on it, and the submitter — who had written a perfectly good og:image —
-- watched us ignore it.
--
-- Nullable, on purpose and permanently. A game with no cover is a normal game:
-- plenty of pages carry no metadata at all, and the shelf already knows how to
-- draw a card without a picture. Making this `not null` would turn "your page
-- has no og:image" into "your game cannot be submitted", which is a rule nobody
-- would agree to if it were written down.
--
-- It lives on both tables because they are two stages of one thing: the
-- submission is what we worked out, and the game is what a reviewer approved.
-- Copying the value forward at approval keeps a later edit to the submission
-- from silently changing what is on the public shelf.

alter table public.vibe_portal_submissions
  add column if not exists cover_url text;

alter table public.vibe_portal_games
  add column if not exists cover_url text;

-- Only ever an absolute http(s) URL. `meta.ts` refuses every other scheme
-- before it gets here — this is the same rule stated where it cannot be
-- bypassed by a future code path that forgets to call the parser. A `data:` or
-- `javascript:` value in this column would be rendered into an `<img src>`.
alter table public.vibe_portal_submissions
  drop constraint if exists vibe_portal_submissions_cover_url_check;
alter table public.vibe_portal_submissions
  add constraint vibe_portal_submissions_cover_url_check
  check (cover_url is null or cover_url ~ '^https?://');

alter table public.vibe_portal_games
  drop constraint if exists vibe_portal_games_cover_url_check;
alter table public.vibe_portal_games
  add constraint vibe_portal_games_cover_url_check
  check (cover_url is null or cover_url ~ '^https?://');

comment on column public.vibe_portal_submissions.cover_url is
  'Cover image read from the submitted page''s og:image, or GitHub''s generated repo card. Null is normal.';
comment on column public.vibe_portal_games.cover_url is
  'Copied from the submission at approval, so editing a submission later cannot change the public shelf.';
