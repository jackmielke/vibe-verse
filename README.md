# VibeVerse

A hub of worlds you can walk, fly, drive and shoot your way through, all in one
browser tab. No install, no account, no launcher — open a link and you are in a
world a few seconds later. Live at [myvibeverse.com](https://myvibeverse.com).

Everything here is fully vibe-coded, and it started as one thing: an
interactive version of **Edge Esmeralda** overlaid on the real Healdsburg map.
That world is still here — it is `/welcome` — but it is now one destination out
of thirty.

## Where to start reading

- **[ARCHITECTURE.md](./ARCHITECTURE.md)** — what is in this repo, how the
  pieces fit, and the numbers. Start here.
- **[CLAUDE.md](./CLAUDE.md)** — the working rules: push straight to `main`,
  verify before pushing, and the contract every new world follows.
- **[WORLDBUILDING.md](./WORLDBUILDING.md)** — everything learned building the
  map-based village world, distilled. Written in the Edge Esmeralda era and
  still the best guide to the Mapbox + Three.js half of the codebase.
- **[src/longsilence/README.md](./src/longsilence/README.md)** — how to vendor
  somebody else's standalone game and turn it into a route.

## The front doors

| Route | What it is |
|---|---|
| `/` | The 3D hub — Vibey on an asteroid, worlds orbiting as spheres |
| `/game` | Every world and game as a flat, fast, searchable index |
| `/terminal` | The same idea in 3D: stand in the sky and pick a world |
| `/welcome` | The original — the real Healdsburg map |

Every destination lives in exactly one place: `src/worlds/registry.ts`. Add a
world there and it appears in the nav, the picker, `/game`, the hub and the
passport at the same moment.

## What is in here

Ten game engines, each in its own directory under `src/`, sharing almost
nothing but the router:

- **San Francisco: Free Fall** (`/sf`) — the real city, hill for hill
- **San Palmas** (`/san-palmas`) — tropical SF, and the vibeverse's FPS
- **The Vibeverse** (`/vibeverse`) — fly a survey ship through a procedural
  galaxy where some of the stars are worlds you can land on
- **Vibe Kart** (`/kart`) — drift, mini-turbos, shells
- **Vibe Golf** (`/golf`) — 63 holes of physics golf with portals and jetpacks
- **Seafair 2117** (`/seafair`) — future Seattle, hydros and Blue Angels
- **Vibe Island II** (`/island-2`) — the floating archipelago, rebuilt
- **Vibe City** (`/city`) — jetpack a neon district, multiplayer, NPCs
- **The Terminal** (`/terminal`) — the 3D lobby
- **Genesis Bloom** (`/evolve`) — play a creature, eat, mutate, survive

…plus the village map, the memory garden, the fractal museum, EDM Town,
Globetrotter, Fruit Ninja, Vibe GO and the rest. `/game` lists all of them.

## The original village map

The Edge Esmeralda world at `/welcome` is still fully wired:

- **Live village map** — Mapbox 3D buildings + custom Three.js landmarks
  anchored to real Healdsburg coordinates
- **Vibey** — the community agent hovering above the plaza. Tap to chat
- **Unit-7** — an autonomous resident bot wandering the streets
- **Sky Patrol** — a pilotable chopper and Nimbus VTOL
- **Spawnables** — heavy GLB worlds that load on demand: a floating island, a
  Death Star, a keyframe-animated micro-city
- **Events + Community panels**, and both a dusk 3D style and a satellite view

## Project layout

```
src/
  App.tsx                     ← the router. 53 paths, ~30 destinations
  worlds/
    registry.ts               ← THE list of worlds. Everything else is a view of it
    art.ts                    ← card art, keyed by world key
  pages/                      ← one thin page per route; the engine lives elsewhere
  components/                 ← app shell (GlobalNav, WorldPicker, VibeRadio),
                                Vibe City's guts, and 49 shadcn/ui primitives

  sf/                         ← San Francisco: Free Fall   (110k lines)
  kart/                       ← Vibe Kart                   (51k)
  longsilence/                ← The Vibeverse — vendored fork, has its own README
  palmas/                     ← San Palmas                  (25k)
  golf/                       ← Vibe Golf                   (23k)
  seafair/                    ← Seafair 2117
  island2/                    ← Vibe Island II
  terminal/                   ← The Terminal (the 3D lobby)
  island/                     ← Island Explorer (react-three-fiber)
  game/                       ← Genesis Bloom (react-three-fiber)

  lib/                        ← the genuinely shared code: passport, characters,
                                economy, wallet, sounds. Deliberately small
  hooks/                      ← identity, active character, world stamps
  integrations/supabase/      ← generated client + types
  assets/glb/                 ← characters, kits, props (see below)
  assets/worlds/              ← world card art, captured from the running worlds
  test/                       ← cross-world tests: registry, passport, chart

scripts/
  route-shot.mjs              ← screenshot any route → world card art
  make-app-icon.mjs           ← regenerate every PWA / apple-touch icon
  sf-shot.mjs, kart-shot.mjs  ← per-world capture harnesses with posed cameras

supabase/functions/           ← 16 edge functions (Vibey chat, the nightly
                                newspaper, the economy, agent replies, …)
docs/
  skills/quaternius-pack.md   ← playbook for adding a new Quaternius asset kit
```

### Adding a new Quaternius / Meshy asset pack

See `docs/skills/quaternius-pack.md` — the short version:

1. Drop FBX/OBJ files in a temp dir, then `assimp export … -fglb2` (animated FBX) or `npx -y obj2gltf -i in.obj -o out.glb -b` (static OBJ)
2. Characters → `src/assets/glb/characters/<name>.glb` — they auto-appear in the Lobby grid via Vite's `import.meta.glob`
3. Themed kits → `src/assets/glb/kits/<kitname>/<category>/*.glb`
4. For scatter packs (trees, props), copy the `NaturePackLayer.ts` pattern; for character packs, the alien's saucer mount is the reference



## Stack

Vite · React · TypeScript · Tailwind · shadcn/ui · Mapbox GL JS · Three.js (GLTF + Draco) · Supabase · Bun

## Running it locally

```bash
bun install          # npm needs --legacy-peer-deps; bun.lock is the real lockfile
bun dev
```

Open <http://localhost:8080>. The Mapbox token is wired through `.env`.

```bash
npm run build        # must pass before anything is pushed — main is always live
npm test             # 253 tests, ~14s
node scripts/make-app-icon.mjs                       # regenerate the PWA icons
node scripts/route-shot.mjs /<route> src/assets/worlds/<key>.jpg   # world card art
```

### Heavy GLB assets (Spawnables)

The Edge Island and Death Star GLBs are too large to ship in the repo and are gitignored. Drop them into `public/models/` to enable those spawn buttons:

- `public/models/edge-island.glb` (~272 MB, Meshy-generated)
- `public/models/death-star.glb` (~60 MB, Meshy-generated)
- `public/models/littlest-tokyo.glb` (~4 MB, from threejs.org examples — re-fetch with `curl -o public/models/littlest-tokyo.glb https://threejs.org/examples/models/gltf/LittlestTokyo.glb`)

Tokyo is small enough to fetch on demand; the bigger Meshy assets are personal exports.

## Notes

- Built on top of Lovable.dev / Cursor / Claude Code as iterative scaffolds, then customized heavily.
- A single `SpawnableLayer` is the generic Three.js → Mapbox bridge; adding a new world is one entry in the `spawnables` list in `MapView.tsx`.
- Everything is anchored to real Healdsburg lng/lat, so Vibey, the helicopter, and the floating island all share the same coordinate system as the live map underneath.

## Tools, references, and inspiration

This project is a personal repository for figuring out how to build immersive, beautiful worlds on the web. Below is the toolkit and reading list I keep coming back to.

### How the layers fit together

```
WebGL  ⟶  Three.js  ⟶  react-three-fiber / A-Frame  ⟶  Edge Esmeralda
(browser GPU API)   (3D library)   (declarative wrappers)
```

- **WebGL** is the browser's low-level GPU API. Powerful but verbose — you write shaders in GLSL and push vertex buffers by hand. <https://webglfundamentals.org/> is the best primer.
- **[Three.js](https://github.com/mrdoob/three.js/)** wraps WebGL into something usable: `new THREE.Mesh(geo, mat)`, scenes, cameras, GLTF loading. Built by Ricardo Cabello (mrdoob) and a huge community. ~100k stars; this is what powers our custom Mapbox layers.
- **[A-Frame](https://aframe.io/)** wraps Three.js into HTML markup (`<a-scene><a-box></a-box></a-scene>`). Originally built at Mozilla. The fastest path to WebXR / browser-based VR — drop a few tags and you can walk around in a Quest headset.
- **[react-three-fiber](https://github.com/pmndrs/react-three-fiber)** is Three.js as React components. With **[drei](https://github.com/pmndrs/drei)** as its standard library, this is the modern way to build 3D React apps.

### 3D engines and helpers

| Tool | Why it's worth knowing |
|---|---|
| [Babylon.js](https://www.babylonjs.com/) | Microsoft-backed Three.js alternative, batteries-included for game-style work. |
| [PlayCanvas](https://playcanvas.com/) | Browser-based Unity-like editor, exports to WebGL. |
| [Hyperfy](https://hyperfy.io/) | Open-source multiplayer 3D worlds — reference architecture if Edge Esmeralda ever goes multi-user. |
| [Rapier](https://rapier.rs/) | Rust physics in WASM — fast, character-collision quality. |
| [theatre.js](https://www.theatrejs.com/) | In-browser timeline animator, drag-and-drop camera flights and keyframes. |
| [CesiumJS](https://cesium.com/platform/cesiumjs/) | 3D globe with real terrain — Mapbox's heavier sibling for planet-scale work. |
| [deck.gl](https://deck.gl/) | High-performance data layers on Mapbox/Leaflet, made by Uber. |

### Asset creation

| Tool | What it does |
|---|---|
| [Meshy](https://www.meshy.ai/) | Text-to-3D and image-to-3D — used for the Edge Island and Death Star here. |
| [Luma AI](https://lumalabs.ai/) | Text/image-to-3D plus NeRF captures (turn a real video into a 3D scene). |
| [Spline](https://spline.design/) | Browser-based 3D editor, designer-friendly, exports to code. |
| [Sketchfab](https://sketchfab.com/) | Massive asset marketplace, lots of free CC0. |
| [Poly Haven](https://polyhaven.com/) | Free CC0 HDRs, textures, models. |
| [Mixamo](https://www.mixamo.com/) | Adobe's free auto-rigging and humanoid animation library. |
| [Blender](https://www.blender.org/) | Free, open-source 3D suite — the standard. |
| [gltf-transform](https://gltf-transform.dev/) | CLI to optimize GLBs (Draco, Meshopt). Drops a 272MB asset to ~30MB. |

### Inspiration

- The official Three.js examples gallery — every interaction pattern, animation, and shader I've needed has had a precedent here: <https://threejs.org/examples/>
- [@om_patel5](https://twitter.com/om_patel5/status/2050062761229496425) — vibe-coded 3D game in a single weekend; the kind of bar I'm aiming at for solo immersive work.
- [@andybroncek](https://twitter.com/andybroncek/status/2042931678989951197) — beautifully art-directed 3D websites; less game, more interactive product page, big inspiration for how UI and 3D can blend.
- [Bruno Simon's "Three.js Journey"](https://threejs-journey.com/) — best paid course; if you want to truly internalize how WebGL/Three.js works, this is the path.
- [Spatial.io](https://www.spatial.io/), [Mozilla Hubs](https://hubs.mozilla.com/) (archived but instructive), and the early Decentraland builds — for thinking about social and multi-user spaces.
- The [glTF specification](https://github.com/KhronosGroup/glTF) — useful to skim once; saves hours of debugging when textures or animations don't work right.

### Things I've already learned the hard way (passing them on)

- **Draco compression is the #1 reason Three.js example models render invisible.** GLTFLoader silently returns empty meshes if you don't register a `DRACOLoader`. We do this in `SpawnableLayer.ts`.
- **Mapbox custom layers get wiped on style toggle.** Always re-mount on `style.load`.
- **Healdsburg sits ~32m above sea level.** If you place a model at altitude 0, it renders underground. Use `queryTerrainElevation({ exaggerated: true })` to get the rendered terrain height.
- **For things that should sit on the ground vs. float in the sky, the model needs to be anchored at its bottom or its center — they're different.** `bottomAnchor` flag in `SpawnableLayer`.
- **Heavy GLBs go in `public/`, not `src/assets/`.** Vite bundles `src/assets` imports into the JS chunk; `public/` is served as static files and lazy-fetched.
