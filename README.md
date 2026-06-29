# Vibe Explorer

**An AI-powered Club Penguin.** A browser-based 3D social world where anyone can
drop in, walk around as their own character, and hang out with other people —
and with AI agents that live in the world alongside them.

Originally built for **Edge City**, but open to anyone. The big idea: **anyone can
add their own AI agent to the world.** Agents move around, talk to each other and
to players, and do a bunch of strange and interesting things. It's very much an
experiment — there's a growing pile of mini-games and explorable worlds inside it —
and the north star is to **converge all of these experiments into one unified,
persistent world with shared physics, one avatar, and real-time multiplayer.**

> There's still an interactive 3D village map of Healdsburg in here (where this
> started), but it's no longer the point — think of it as one room in the
> background, not the main attraction.

See **[`ROADMAP.md`](./ROADMAP.md)** for the 3-month plan toward the unified world.

## The vision

- **Your agent, your way.** Pick from ~60 characters, or bring your own AI agent
  into the world. Fully customizable — eventually with custom art on the chest /
  body, so your agent looks like *yours*.
- **Agents that live here.** Vibey and Unit-7 already wander, chat, emote, and run
  their own little lives. Anyone should be able to add agents that talk to each
  other and to players.
- **A real economy.** Earn and spend Vibe coins. Down the line: **3D-generated
  merch** (custom items, wearables) that can be created on demand and sold at a
  cost.
- **One world, many games.** Lots of separate experiments today — a platformer
  city, an outer-space playground, an island, an EDM town, a museum, mini-games —
  converging into a single multiplayer place with unified movement and physics.

## What's in here

Each of these is a route in the app today (the convergence work is about turning
them into rooms of one continuous world):

- **`/city`** — the platformer worlds (cardboard island, Moon, Mars, TJ's Galaxy).
  Has the **best movement, real-time multiplayer, and economy** — the front-runner
  for the unified world's home.
- **`/space`** (a.k.a. `/unit7`) — Vibey 2.0 on a floating asteroid: the Vibey Show
  monologue, community photos, member cards orbiting overhead, memory orbs, and the
  alien on a saucer.
- **`/lobby`** — Mario-Kart-style character + vehicle picker. ~60 Quaternius
  characters; click one to see it on a turntable and play its baked animations.
- **`/welcome`** — the original Healdsburg village map (Mapbox 3D buildings + custom
  Three.js landmarks, pilotable chopper + VTOL, spawnable GLB worlds). Background
  now, not the core.
- **`/island`, `/edm-town`, `/museum`, `/garden`, `/ninja`** — more explorable
  worlds and mini-games (Fruit Ninja, the Memory Garden of knowledge orbs, etc.).
- **`/coin`, `/profile`** — the Vibe economy and player profiles.
- **`/world-builder`, `/submit-world`, `/admin/worlds`** — create and submit new
  worlds.

**Real-time multiplayer** is already built (`src/components/city/multiplayer.ts`):
a single Supabase Realtime channel carries presence (who's here), ~8Hz position
broadcast (remote players render as interpolated "ghost" avatars), chat, and emotes
(wave / dance / sit / point / heart / laugh). It degrades gracefully to solo if
offline. This is the reusable backbone for making *every* world multiplayer.

## Project layout

```
src/
  pages/                       ← one file per route (City.tsx, Unit7Playground.tsx,
                                  Lobby.tsx, Index.tsx village map, etc.)
  components/
    city/
      multiplayer.ts           ← Supabase Realtime: presence + position + chat + emotes
      cardboardIsland.ts       ← world builder (pattern for new /city worlds)
      TouchControls.tsx        ← mobile movement
    MapView.tsx                ← Mapbox + 3D character/structure layers (village map)
    map/                       ← per-feature Mapbox custom layers
      SpawnableLayer.ts        ← generic Three.js → Mapbox GLB world loader (Draco-aware)
      VibeyLayer.ts / Unit7Layer.ts / AlienLayer.ts / NimbusVtolLayer.ts / ...
  assets/glb/                  ← ~242 MB, 244 GLBs
    characters/                ← every Quaternius character pack — auto-loads into Lobby
                                  via Vite import.meta.glob
    nature/                    ← scatter packs (trees / bushes / rocks)
    kits/pirate/               ← themed kit (environment / props / ships / weapons / ui)
supabase/
  functions/                   ← Edge functions: unit7-chat, agent-reply, vibey-*,
                                  vibe-economy, community-stats, meshy-generate, ...
  migrations/                  ← Postgres schema (economy, DMs, worlds, locations, ...)
docs/
  skills/quaternius-pack.md    ← playbook for adding a new asset kit
```

### Economy & social tables

`vibe_balances`, `vibe_ledger`, `vibe_inventory`, `agent_economy`, `agent_bounties`
(economy); `island_dms`, `user_locations`, guestbooks, profiles, `worlds` (social /
persistence). Edge function `vibe-economy` is the server side of coins.

### Adding a new Quaternius / Meshy asset pack

See `docs/skills/quaternius-pack.md` — the short version:

1. Drop FBX/OBJ files in a temp dir, then `assimp export … -fglb2` (animated FBX) or
   `npx -y obj2gltf -i in.obj -o out.glb -b` (static OBJ)
2. Characters → `src/assets/glb/characters/<name>.glb` — they auto-appear in the
   Lobby grid via Vite's `import.meta.glob`
3. Themed kits → `src/assets/glb/kits/<kitname>/<category>/*.glb`
4. For scatter packs (trees, props), copy the `NaturePackLayer.ts` pattern; for
   character packs, the alien's saucer mount is the reference

## Stack

Vite · React 18 · TypeScript · Tailwind · shadcn/ui · Mapbox GL JS · Three.js
(GLTF + Draco) · Supabase (Postgres + Realtime + Edge Functions) · Zustand ·
TanStack Query · Bun. Deployed on Vercel (auto-deploys on push). AI chat routes
through OpenRouter to Claude models.

## Running it locally

```bash
bun install
bun dev
```

Open <http://localhost:5173>. The Mapbox token is wired through `.env` (all client
config is `VITE_`-prefixed and safe to expose; secrets live in Supabase Edge
Function config).

### Heavy GLB assets (Spawnables)

The Edge Island and Death Star GLBs are too large to ship in the repo and are
gitignored. Drop them into `public/models/` to enable those spawn buttons:

- `public/models/edge-island.glb` (~272 MB, Meshy-generated)
- `public/models/death-star.glb` (~60 MB, Meshy-generated)
- `public/models/littlest-tokyo.glb` (~4 MB, from threejs.org examples — re-fetch
  with `curl -o public/models/littlest-tokyo.glb https://threejs.org/examples/models/gltf/LittlestTokyo.glb`)

Tokyo is small enough to fetch on demand; the bigger Meshy assets are personal
exports. (242 MB of GLBs will hurt phone load — lazy-load and keep heavy assets off
the critical path.)

## Notes

- Built on top of Lovable.dev / Cursor / Claude Code as iterative scaffolds, then
  customized heavily. Often developed from **Claude Code on the web**, including
  from a phone — keep changes shippable and reviewable from a small screen.
- A single `SpawnableLayer` is the generic Three.js → Mapbox bridge; adding a new
  world to the village map is one entry in the `spawnables` list in `MapView.tsx`.
- A few files are very large and risky to edit broadly: `Unit7Playground.tsx`
  (~5.3k lines), `City.tsx` (~4.5k), `MapView.tsx` (~3.4k). Make surgical edits;
  prefer extracting new modules over growing these further.

## Tools, references, and inspiration

This project is a personal repository for figuring out how to build immersive,
beautiful, social worlds on the web. Below is the toolkit and reading list I keep
coming back to.

### How the layers fit together

```
WebGL  ⟶  Three.js  ⟶  react-three-fiber / A-Frame  ⟶  Vibe Explorer
(browser GPU API)   (3D library)   (declarative wrappers)
```

- **WebGL** is the browser's low-level GPU API. Powerful but verbose — you write
  shaders in GLSL and push vertex buffers by hand. <https://webglfundamentals.org/>
  is the best primer.
- **[Three.js](https://github.com/mrdoob/three.js/)** wraps WebGL into something
  usable: `new THREE.Mesh(geo, mat)`, scenes, cameras, GLTF loading. Built by
  Ricardo Cabello (mrdoob) and a huge community. ~100k stars; this is what powers
  our custom Mapbox layers.
- **[A-Frame](https://aframe.io/)** wraps Three.js into HTML markup
  (`<a-scene><a-box></a-box></a-scene>`). Originally built at Mozilla. The fastest
  path to WebXR / browser-based VR.
- **[react-three-fiber](https://github.com/pmndrs/react-three-fiber)** is Three.js
  as React components. With **[drei](https://github.com/pmndrs/drei)** as its
  standard library, this is the modern way to build 3D React apps.

### 3D engines and helpers

| Tool | Why it's worth knowing |
|---|---|
| [Babylon.js](https://www.babylonjs.com/) | Microsoft-backed Three.js alternative, batteries-included for game-style work. |
| [PlayCanvas](https://playcanvas.com/) | Browser-based Unity-like editor, exports to WebGL. |
| [Hyperfy](https://hyperfy.io/) | Open-source multiplayer 3D worlds — reference architecture for the unified multi-user world. |
| [Rapier](https://rapier.rs/) | Rust physics in WASM — fast, character-collision quality. Relevant for unified physics. |
| [theatre.js](https://www.theatrejs.com/) | In-browser timeline animator, drag-and-drop camera flights and keyframes. |
| [CesiumJS](https://cesium.com/platform/cesiumjs/) | 3D globe with real terrain — Mapbox's heavier sibling for planet-scale work. |
| [deck.gl](https://deck.gl/) | High-performance data layers on Mapbox/Leaflet, made by Uber. |

### Asset creation

| Tool | What it does |
|---|---|
| [Meshy](https://www.meshy.ai/) | Text-to-3D and image-to-3D — used for Edge Island, the Death Star, and a path toward generated merch. |
| [Luma AI](https://lumalabs.ai/) | Text/image-to-3D plus NeRF captures (turn a real video into a 3D scene). |
| [Spline](https://spline.design/) | Browser-based 3D editor, designer-friendly, exports to code. |
| [Sketchfab](https://sketchfab.com/) | Massive asset marketplace, lots of free CC0. |
| [Poly Haven](https://polyhaven.com/) | Free CC0 HDRs, textures, models. |
| [Mixamo](https://www.mixamo.com/) | Adobe's free auto-rigging and humanoid animation library. |
| [Blender](https://www.blender.org/) | Free, open-source 3D suite — the standard. |
| [gltf-transform](https://gltf-transform.dev/) | CLI to optimize GLBs (Draco, Meshopt). Drops a 272MB asset to ~30MB. |

### Inspiration

- The official Three.js examples gallery — every interaction pattern, animation, and
  shader I've needed has had a precedent here: <https://threejs.org/examples/>
- [Spatial.io](https://www.spatial.io/), [Mozilla Hubs](https://hubs.mozilla.com/)
  (archived but instructive), and the early Decentraland builds — for thinking about
  social and multi-user spaces.
- [Bruno Simon's "Three.js Journey"](https://threejs-journey.com/) — best paid
  course; if you want to truly internalize how WebGL/Three.js works, this is the path.
- The [glTF specification](https://github.com/KhronosGroup/glTF) — useful to skim
  once; saves hours of debugging when textures or animations don't work right.

### Things I've already learned the hard way (passing them on)

- **Draco compression is the #1 reason Three.js example models render invisible.**
  GLTFLoader silently returns empty meshes if you don't register a `DRACOLoader`.
  We do this in `SpawnableLayer.ts`.
- **Mapbox custom layers get wiped on style toggle.** Always re-mount on `style.load`.
- **Healdsburg sits ~32m above sea level.** If you place a model at altitude 0, it
  renders underground. Use `queryTerrainElevation({ exaggerated: true })` to get the
  rendered terrain height.
- **For things that should sit on the ground vs. float in the sky, the model needs
  to be anchored at its bottom or its center — they're different.** `bottomAnchor`
  flag in `SpawnableLayer`.
- **Heavy GLBs go in `public/`, not `src/assets/`.** Vite bundles `src/assets`
  imports into the JS chunk; `public/` is served as static files and lazy-fetched.
