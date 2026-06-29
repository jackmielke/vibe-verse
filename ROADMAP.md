# Roadmap — toward "the next Club Penguin"

> Working brainstorm, 2026-06-29. A living doc — edit freely.

## North star

**One persistent, multiplayer world. One avatar. Real people in it together.
Reasons to come back.**

Today the project is an impressive *archipelago* of ~8 separate 3D experiences on
separate routes that don't fully share an avatar, economy, or presence layer. The
core strategic move for the next few months is **convergence**, not more breadth:
turn the experiments into rooms of one continuous world.

## What we already have (the Club Penguin bones)

Most of the hard primitives exist — they're just scattered:

- **Real-time multiplayer** — `src/components/city/multiplayer.ts`: presence,
  position broadcast (~8Hz ghost avatars), chat, emotes. This is the backbone.
- **Economy** — `vibe_balances`, `vibe_ledger`, `vibe_inventory`, `agent_bounties`.
- **Social** — DMs (`island_dms`), profiles, communities, location sharing.
- **Identity/auth** — "Log in with Vibe".
- **Avatars** — ~60 characters with baked animations (the Lobby).
- **Touch controls** — already exist for mobile play.
- **AI agents** — Vibey & Unit-7 as living NPCs.

## Known risks to address along the way

- **Sprawl**: 8 worlds, inconsistent shared state. (The whole point of convergence.)
- **Mobile performance**: 242 MB of GLBs in-repo; heavy worlds block phone load.
- **Maintainability**: `Unit7Playground.tsx` (~5.3k lines), `City.tsx` (~4.5k),
  `MapView.tsx` (~3.4k) are hard to change safely. Extract modules over time.
- **Safety**: real multiplayer chat with strangers needs moderation/safe-chat
  before any kind of public/younger audience.

## 3-month plan

### Month 1 — Converge & make it feel alive
- [ ] Pick **one** home world as the front door (recommend `/city` — best movement +
      multiplayer + economy already wired).
- [ ] Lift `multiplayer.ts` into a **shared world layer** so presence + chat + emotes
      work in *every* room, not just City.
- [ ] **Persistent avatar identity**: the Lobby character you pick is *you*,
      everywhere. Carries between rooms.
- [ ] Treat other worlds (space, island, EDM town, museum) as **rooms** you travel
      to, keeping your avatar + coins.

### Month 2 — Reasons to come back (the core loop)
- [ ] **Coins → items → show off**: wire earning into a wardrobe/inventory that other
      players can see on your avatar (we have the economy + 244 GLB assets already).
- [ ] **Mini-games that pay coins**: make Fruit Ninja pay out; build Cart Run /
      scavenger hunt (see `.lovable/plan.md` TJ's ideas).
- [ ] **Your own room/igloo to decorate** — the single stickiest Club Penguin
      mechanic. Build on the existing worlds + submission system.

### Month 3 — Events & retention
- [ ] **Scheduled parties/events** — tie to the real Edge Esmeralda events already
      surfaced on the map. Club Penguin lived on these.
- [ ] **Daily login coins**, friends list (DMs exist), presence-aware "who's online".
- [ ] **Safe-chat / moderation** — non-negotiable before strangers meet.
- [ ] **Mobile-first perf pass**: lazy-load assets behind a CDN, code-split routes,
      get phone first-load fast.

## Cloud / phone workflow

- This repo is built to be driven from **Claude Code on the web** (claude.ai/code),
  including from a phone — kick off sessions, review diffs, approve PRs on mobile.
- Run **parallel sessions** in the cloud to move on multiple tracks at once.
- A `CLAUDE.md` (added) gives every session instant context.
- A SessionStart hook (`.claude/hooks/session-start.sh`) auto-runs `bun install` so
  tests/lint are ready immediately in web sessions. Once merged to the default
  branch, all future web sessions use it.

## Open questions to revisit

- Audience: Edge Esmeralda community insiders, or a broader public game?
- Is the real-world Healdsburg map central to the identity, or one room among many?
- How central are the AI agents (Vibey/Unit-7) — flavor, or a core differentiator
  vs. classic Club Penguin?
