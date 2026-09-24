-- The Magic Screen's ledger: one row per program written, for the daily
-- budget in vibe-magician-screen. Service role only, like the voice ledger.
create table if not exists public.vibe_magician_screen (
  id bigserial primary key,
  device_id text not null,
  ip text,
  request text not null default '',
  model text not null default '',
  chars integer not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists vibe_magician_screen_device_created on public.vibe_magician_screen (device_id, created_at desc);
create index if not exists vibe_magician_screen_created on public.vibe_magician_screen (created_at desc);
alter table public.vibe_magician_screen enable row level security;
-- The program itself, so the valley's screens can be looked back through.
alter table public.vibe_magician_screen add column if not exists code text;
