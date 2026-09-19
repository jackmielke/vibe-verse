-- Talking to The Magician costs real money per minute, so every device gets
-- ten free minutes and the edge function that holds the OpenAI key keeps the
-- count here. Nothing in the app reads or writes this table directly: the
-- function uses the service role, so RLS is on with no policies and the anon
-- key sees nothing.
create table if not exists public.vibe_magician_usage (
  device_id text primary key,
  seconds_used integer not null default 0,
  -- Extra seconds granted: a purchase, or a top-up by hand.
  seconds_granted integer not null default 0,
  sessions integer not null default 0,
  -- The session in flight, so a client that stops reporting still gets
  -- charged for it when it next asks.
  session_started_at timestamptz,
  session_last_seen_at timestamptz,
  last_ip text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.vibe_magician_usage enable row level security;
comment on table public.vibe_magician_usage is 'Free-minute budget for the voice in /magician, kept by vibe-magician-voice.';
