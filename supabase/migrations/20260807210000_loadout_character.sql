-- Which character you are playing as, as a fact about a person rather than
-- about a browser.
--
-- Until now the active character lived in `localStorage["lobby.character"]`
-- and nowhere else, which was fine while every character was free: the worst
-- case was that you picked the Wizard again on your phone. The arcade's
-- character shop makes it a purchase, and a purchase that only your laptop
-- remembers is not a purchase.
--
-- Named `char_id` rather than `character`: CHARACTER is a SQL keyword (as in
-- CHARACTER VARYING), and while Postgres would accept it as a column name it
-- is the sort of thing that bites in a hand-written query six months from now.
-- The edge function maps it to `character` in its JSON, so the client sees the
-- word it actually means.
--
-- Default 'vibey' to match the client's fallback in `use-active-character`.
-- The default has to be something free, or every new wallet would start out
-- wearing something the server would then refuse to let it re-equip.
alter table public.vibe_loadout
  add column if not exists char_id text not null default 'vibey';

comment on column public.vibe_loadout.char_id is
  'Active character id, from src/lib/characters.ts. Priced ones are listed in the vibe-economy COSMETICS.character table and require a matching vibe_inventory row; everything else is free roster.';
