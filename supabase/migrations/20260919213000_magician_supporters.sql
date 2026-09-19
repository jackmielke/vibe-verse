-- The supporters' board in Hoshimura. Anyone may sign it (a name and a line)
-- after donating; it is a guestbook, not a receipt, and the board says so.
-- Amounts are self-reported until a Stripe webhook is wired.
create table if not exists public.vibe_magician_supporters (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 40),
  message text not null default '' check (char_length(message) <= 140),
  amount_cents integer check (amount_cents is null or (amount_cents >= 0 and amount_cents <= 1000000)),
  verified boolean not null default false,
  device_id text,
  created_at timestamptz not null default now()
);
alter table public.vibe_magician_supporters enable row level security;
create policy "supporters are public" on public.vibe_magician_supporters for select using (true);
create policy "anyone may sign the board" on public.vibe_magician_supporters for insert with check (verified = false);
create index if not exists vibe_magician_supporters_created_idx on public.vibe_magician_supporters (created_at desc);
comment on table public.vibe_magician_supporters is 'Names and lines on the supporters board in /magician. Self-reported until verified by webhook.';
