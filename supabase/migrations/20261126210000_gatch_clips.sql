-- Gatch News clips you can share (Cannon Chase, Nov 2026).
--
-- A replay clip lives in the player's browser until they press Share. Then the
-- gatch-clip edge function stores the video in the public `gatch-clips`
-- bucket and a row here, and the link /gatch/<id> plays it for anybody.
-- Nobody writes either directly: the function holds the service key, checks
-- the bytes are a real WebM/MP4 under 8 MB, and caps uploads per day.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('gatch-clips', 'gatch-clips', true, 8388608, array['video/webm', 'video/mp4'])
on conflict (id) do nothing;

create table if not exists public.gatch_clips (
  id          text primary key check (id ~ '^[a-z0-9]{8,16}$'),
  path        text not null,
  headline    text not null default '' check (char_length(headline) <= 120),
  sub         text not null default '' check (char_length(sub) <= 160),
  type        text not null default 'video/webm',
  bytes       integer not null default 0,
  sender      text not null default '',   -- a salted hash of the IP, for the daily cap only
  created_at  timestamptz not null default now()
);

create index if not exists gatch_clips_created on public.gatch_clips (created_at);

alter table public.gatch_clips enable row level security;
drop policy if exists "gatch clips readable" on public.gatch_clips;
create policy "gatch clips readable" on public.gatch_clips for select using (true);
revoke all on public.gatch_clips from anon, authenticated;
grant select (id, path, headline, sub, type, created_at) on public.gatch_clips to anon, authenticated;
