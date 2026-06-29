# CLAUDE.md

Guidance for Claude Code (and any AI agent) working in this repo. Read this first
each session so you don't have to re-derive the project from scratch.

## What this is

**Vibe Explorer** — an **AI-powered Club Penguin**. A vibe-coded, browser-based 3D
social world where anyone can drop in, walk around as their own character, and hang
out with other people *and* with AI agents that live in the world. Originally built
for **Edge City**, but open to anyone.

The defining idea: **anyone can add their own AI agent to the world** — agents move
around, talk to each other and to players, and do interesting things. It's an
experiment with a growing set of mini-games and explorable worlds.

The long-term north star: **converge the experiments into one persistent,
multiplayer world with unified physics and one avatar** — "the next Club Penguin."
See `ROADMAP.md`.

> The interactive 3D village map of Healdsburg (Mapbox + Three.js) is where this
> started and still exists at `/welcome`, but it is **no longer a core feature** —
> treat it as background/one room, not the primary thing. The flagship surface is
> `/city` (best movement + multiplayer + economy).

Vision threads to keep in mind: fully **customizable agents** (e.g. custom art on
the chest/body so your agent looks like *yours*), and **3D-generated merch** /
wearables created on demand and sold for Vibe coins.

## Stack

Vite · React 18 · TypeScript · Tailwind · shadcn/ui · Mapbox GL JS · Three.js
(GLTF + Draco) · Supabase (Postgres + Realtime + Edge Functions) · Zustand ·
TanStack Query · Bun. Deployed on Vercel (auto-deploys on push).

## Commands

```bash
bun install        # install deps (package manager is Bun; bun.lock is source of truth)
bun dev            # dev server at http://localhost:5173
bun run build      # production build (tsc + vite build)
bun run lint       # eslint
bun run test       # vitest run (one-shot)
bun run test:watch # vitest watch
```

Node 22 / Bun 1.3 in the cloud environment.

## Environment

`.env` holds public client config (all `VITE_`-prefixed, safe to expose):
`VITE_SUPABASE_URL`, `VITE_SUPABASE_PROJECT_ID`, `VITE_SUPABASE_PUBLISHABLE_KEY`,
plus a Mapbox token wired through the build. Secrets live in Supabase Edge
Function config, not in the client.

## Routes (src/App.tsx)

| Path | Page | Notes |
|------|------|-------|
| `/` , `/hub` | `HubV2` | Home hub |
| `/welcome` | `Index` | Healdsburg village map (Mapbox + 3D landmarks) |
| `/city` | `City` | Platformer worlds (cardboard island, Moon, Mars, TJ's). **Has the best movement + multiplayer + economy** |
| `/space`, `/unit7` | `Unit7Playground` | Vibey 2.0 outer-space playground |
| `/lobby` | `Lobby` | Mario-Kart-style character + vehicle picker (~60 chars) |
| `/island`, `/island-explorer` | `IslandExplorer` | |
| `/edm-town` | `EdmTown` | |
| `/museum` | `Museum` | |
| `/garden` | `MemoryGarden` | Edge memories as knowledge orbs |
| `/ninja` | `FruitNinja` | Mini-game |
| `/coin` | `VibeHub` | Vibe economy |
| `/profile` | `VibeProfile` | |
| `/world-builder`, `/submit-world`, `/admin/worlds` | World creation/submission | |
| `/evolve`, `/bestiary`, `/about` | misc | |

## Architecture notes

- **Multiplayer** lives in `src/components/city/multiplayer.ts` — a single Supabase
  Realtime channel (`vibe-city`) carrying presence (who's here), position broadcast
  (~8Hz, remote players render as interpolated "ghost" avatars), chat, and emotes
  (wave/dance/sit/point/heart/laugh). Degrades gracefully to solo if offline.
  This is the reusable backbone for making *every* world multiplayer.
- **Economy**: tables `vibe_balances`, `vibe_ledger`, `agent_economy`,
  `agent_bounties`, `vibe_inventory`. Edge function `vibe-economy`.
- **Social/persistence**: `island_dms`, `user_locations` (RLS-gated location
  sharing scoped to shared communities), guestbooks, profiles, `worlds`.
- **AI agents**: Vibey + Unit-7. Edge functions `unit7-chat`, `agent-reply`,
  `vibey-monologue`, `vibey-compose`, `vibey-identity`, `vibey-journal`. Chat
  routes through OpenRouter to Claude models.
- **3D assets**: `src/assets/glb/` (~242 MB, 244 GLBs). Characters auto-load into
  the Lobby via Vite `import.meta.glob`. Heavy spawnable worlds (Edge Island ~272MB,
  Death Star ~60MB) are gitignored and live in `public/models/` locally.
- **Supabase client**: `src/integrations/supabase/client.ts`; generated types in
  `src/integrations/supabase/types.ts` (5k+ lines — regenerate, don't hand-edit).

## Conventions & gotchas

- Path alias `@/` → `src/` (vite + vitest + tsconfig).
- shadcn/ui components in `src/components/ui` — don't hand-edit generated primitives;
  compose around them.
- A few files are very large and risky to edit broadly: `Unit7Playground.tsx`
  (~5.3k lines), `City.tsx` (~4.5k), `MapView.tsx` (~3.4k). Make surgical edits;
  prefer extracting new modules over growing these further.
- The repo is Lovable-originated (`lovable-tagger` dev dep); `.lovable/plan.md` may
  hold an in-progress design note.
- Adding asset packs: see `docs/skills/quaternius-pack.md`.
- Mind mobile: 242 MB of GLBs will hurt phone load. Lazy-load / keep heavy assets
  off the critical path.

## Git / workflow

- Deployed via Vercel on push to the tracked branch.
- Don't commit heavy `.glb` worlds (gitignored on purpose).
- This project is often developed from Claude Code on the web (incl. phone). Keep
  changes shippable and reviewable from a small screen.
