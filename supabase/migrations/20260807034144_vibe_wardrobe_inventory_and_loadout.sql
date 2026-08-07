-- Cosmetics you actually own, and what you are wearing.
--
-- Both tables follow the same rule as the rest of the vibe_* family: readable
-- by anyone (the shop and the leaderboards are public information), writable
-- only by the `vibe-economy` edge function through the service role. There is
-- deliberately no INSERT/UPDATE policy — a browser that could write its own
-- inventory row could give itself a crown for free.

-- One of each. Buying a hat you already own should fail loudly at the database
-- rather than quietly charge twice, which is the failure a client retry causes.
create unique index if not exists vibe_inventory_owner_item_uniq
  on public.vibe_inventory (owner_kind, owner_ref, item_key);

create table if not exists public.vibe_loadout (
  owner_kind  text not null,
  owner_ref   text not null,
  -- Cosmetic ids from the catalogs in src/components/city/cosmetics.ts. Stored
  -- as loose text on purpose: the catalog is code and it changes, and a foreign
  -- key into a list that lives in a TypeScript file is a migration every time
  -- somebody adds a hat.
  hat         text not null default 'none',
  flame       text not null default 'mint',
  jetpack     text not null default 'stock',
  updated_at  timestamptz not null default now(),
  primary key (owner_kind, owner_ref)
);

alter table public.vibe_loadout enable row level security;

drop policy if exists "loadout readable by all" on public.vibe_loadout;
create policy "loadout readable by all"
  on public.vibe_loadout for select
  using (true);

comment on table public.vibe_loadout is
  'What each wallet is wearing. Written only by the vibe-economy edge function.';
