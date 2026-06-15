# Pivot to a Vibe-Coded Worlds Platform

Turn the hub from a curated Edge Esmeralda lobby into a creator-driven launcher where any logged-in user can submit a world (GitHub repo + scene route + preview) and any character (name + GLB asset). Anonymous visitors can still explore everything; login is only required to contribute or save your identity.

This is **Phase 1: foundations + submissions**. Per-world hover preview side-panel, multiplayer presence per world, and rebrand-from-Edge-Esmeralda come in later passes.

## Scope of this pass

1. New Supabase tables: `worlds`, `world_characters` (plus storage bucket for previews/GLBs).
2. Seed the existing 3 worlds + 8 characters from `HubV2.tsx` into the DB so nothing visually changes day one.
3. Hub loads worlds & characters from DB instead of hardcoded arrays.
4. New `/submit-world` page (login-gated) with a form: name, blurb, GitHub URL, scene route or external URL, preview image upload, tags.
5. New `/submit-character` page (login-gated): name, GLB upload (or URL), optional scale override.
6. Light moderation: submissions default to `status = 'pending'`. Hub only shows `status = 'approved'`. You (admin role, already exists via `has_role`) can approve from a simple `/admin/worlds` list.
7. Anonymous browse stays the default — no auth wall on `/`.

## Out of scope (next passes)

- Hover preview side-panel with creator avatar, GH link, play count.
- Per-world `world_vehicles` join table.
- Multiplayer presence ("3 people in this world now").
- Visual rebrand away from Edge Esmeralda.
- Vibecoin unlocks for premium characters.

## Data model

```text
worlds
  id              uuid pk
  slug            text unique           -- e.g. "cardboard-island"
  name            text
  blurb           text
  creator_id      uuid → users.id       -- vibe profile
  github_url      text nullable
  route           text                  -- "/city?spawn=island" OR external https://
  preview_url     text                  -- storage public URL
  hero_model_url  text nullable         -- optional GLB shown instead of sphere
  tags            text[]
  status          text                  -- 'pending' | 'approved' | 'rejected'
  is_featured     bool                  -- pin to front of hub row
  sort_order      int
  play_count      int default 0
  created_at, updated_at

world_characters
  id              uuid pk
  slug            text unique
  name            text
  emoji           text nullable
  asset_url       text                  -- GLB URL (storage or external)
  scale_override  numeric nullable      -- e.g. 0.9 for Vibey
  creator_id      uuid → users.id nullable  -- null = official
  status          text                  -- 'pending' | 'approved'
  sort_order      int
  created_at, updated_at
```

### Access rules (plain English)

- **worlds**: anyone (incl. anonymous) can read rows where `status = 'approved'`. Logged-in users can insert (forced to `status = 'pending'`, `creator_id = auth user`). Creators can edit their own pending rows. Admins can do anything.
- **world_characters**: same pattern.
- **Storage bucket `world-assets**`: public read, authenticated write, file size cap (e.g. 25 MB for GLBs, 5 MB for previews).

## Hub changes

`src/pages/HubV2.tsx` currently hardcodes ~9 worlds and 8 characters. Replace those arrays with a `useQuery` that pulls approved rows. Keep the existing 3D layout code unchanged — it just iterates over whatever the query returns. Add a tiny "+ Submit your world" tile at the end of the worlds row that links to `/submit-world`.

## New pages

- `/submit-world` — form + preview-image upload. Requires login (redirects to existing auth flow if not signed in).
- `/submit-character` — same pattern, GLB upload.
- `/admin/worlds` — admin-only list with Approve / Reject buttons, gated by `has_role(auth.uid(), 'admin')`.

## Seeding

A single insert migration that mirrors the current hardcoded worlds (Cardboard Island, Vibe Hub, City, Garden, Museum, Evolve, Fruit Ninja, Vibe Gallery, About) and characters (Vibey, Alien, Wizard, Knight, …) with `status = 'approved'`, `creator_id = null` (official), preserving current `sort_order`. The hub looks identical post-migration.

## Open questions you can answer now or after I start

- **GLB hosting**: upload to Supabase Storage (recommended, keeps things self-contained) or paste an external URL (simpler, no quota)? I'll default to "either works — upload field + URL field, one required."
- **GitHub URL required?** I'll make it optional for now since not every world has a repo (e.g. the Map).
- **Character submissions in this pass, or just worlds first?** Plan includes both because they share the same shape; happy to defer characters if you want a smaller pass. lets not do this yet tho actually