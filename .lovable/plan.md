# Social Core v1 — Duels + Leave-behinds

Building on what already works in `/city`: real-time presence, chat bubbles, and the emote wheel (`src/components/city/multiplayer.ts` + `src/pages/City.tsx`). Two new threads, both designed to feel alive even when nobody's online (async-friendly).

## 1. Walk-up duels: RPS + Emote Match

**Trigger.** When your player stands within ~2.5m of another peer for >0.6s, a "👋 Challenge {name}" prompt appears above their head. Press **E** (or tap the prompt on mobile) to send a duel invite. The other player sees an Accept / Decline toast for 8s.

**Round flow (shared overlay).**
- Coin flip picks game: **Rock-Paper-Scissors** or **Emote Match** (mirror the opponent's emote within 3s).
- Best-of-3. Each round ~5s. Result floats above both players ("WIN" / "LOSE" / "TIE") and broadcasts a sparkle emote.
- Win streaks tracked per-session; "first blood / 3-streak" gets a chat bubble shout-out.

**Transport.** Add three new message kinds to the existing presence channel — no new tables yet:
- `duel:invite { fromId, toId, game, nonce }`
- `duel:move { duelId, round, choice }` (rock|paper|scissors, or emote name)
- `duel:end { duelId, winnerId, score }`
Both clients are authoritative for their own move; tie-break by lower peer-id on conflict.

**UI.** New `src/components/city/DuelOverlay.tsx` — centered glass card, 3 big choice buttons, round counter, opponent name. Reuses the emote sprite system for "throw" animation.

## 2. Leave-behinds at locations

A persistent, world-anchored note/gift/graffiti you drop where you stand. Anyone in `/city` later sees it floating as a small glowing icon; click to read.

**New table `world_leavebehinds`** (Lovable Cloud / Supabase):
- `id, world` (text, e.g. 'city'), `x, y, z` (real)
- `kind` ('note' | 'gift' | 'graffiti')
- `emoji` (text, optional), `text` (text, ≤140 chars)
- `author_name` (text, from vibe identity), `author_id` (uuid nullable — works signed-out)
- `color` (text, from vibe palette), `created_at`, `expires_at` (default now()+14 days)
- RLS: public read; insert allowed for anyone (rate-limited client-side, 1/min); delete by author_id only when signed in.
- GRANTs: `SELECT` to anon+authenticated; `INSERT` to anon+authenticated; `UPDATE/DELETE` to authenticated; ALL to service_role.

**In-world rendering.** New `src/components/city/leavebehinds.ts` — loads all rows for `world='city'` on spawn, renders each as a small `THREE.Sprite` with the emoji on a translucent disc in the vibe color. Approaching (<2m) opens a little popover with the text + author. A "🪧 Leave something here" HUD button (next to Emote) opens a tiny composer: kind picker (note/gift/graffiti), emoji, ≤140 chars, post.

**Discovery.** Tiny "+N nearby" counter near the minimap so empty plazas feel populated by past visitors.

## Out of scope (next slices)
- Plaza/Lobby for idle players
- VIBECOIN in mini-games
- Homes + Agent Village bridge

## Technical notes
- No schema changes for duels; reuses presence channel.
- Leave-behinds is the only DB change — single migration with GRANTs + RLS as above.
- All new UI uses existing semantic tokens; no hardcoded colors.
- Mobile: duel prompt + composer use the same glass-panel pattern as the emote wheel.

## Files

```text
new   src/components/city/DuelOverlay.tsx
new   src/components/city/leavebehinds.ts
new   src/components/city/LeaveBehindComposer.tsx
edit  src/components/city/multiplayer.ts   // duel message kinds + handlers
edit  src/pages/City.tsx                   // wire overlay, proximity prompt, HUD button
db    migration: create public.world_leavebehinds + GRANTs + RLS
```

Want me to start with **duels first**, **leave-behinds first**, or build them in parallel?
