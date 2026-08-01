# The VibeVerse

**A massive collection of AI-coded games by Jack Mielke and friends.**

Thirty-odd worlds and games, every one of them vibe-coded, all served from one
website. No install, no account, no launcher, no store page — open a link and
you are inside a world a few seconds later. Live at
[myvibeverse.com](https://myvibeverse.com).

It is a real collection: a 110,000-line open-world game set in the actual
geometry of San Francisco, an arcade kart racer, a tropical FPS, 63 holes of
physics golf, a procedural galaxy you fly a survey ship through, an evolution
sim, a geoguessing game, and a floating village built on top of the real
Healdsburg map, which is where the whole thing started.

Nobody planned this as a portfolio. Each world was its own spontaneous weekend
project, built fast because the tools got fast, and they ended up in one repo
because a hub of thirty games is more fun than thirty abandoned tabs.

**Start at [/game](https://myvibeverse.com/game)** — every world and game on
one page.

## The collection

Everything below is playable in a browser right now. `/game` is the same list,
with screenshots.

### Games

| | Game | Where | What it is |
|---|---|---|---|
| 🌉 | **San Francisco: Free Fall** | `/sf` | The real city, hill for hill, bridge for bridge. Fly it now; grapple and wingsuit soon. |
| 🌴 | **San Palmas** | `/san-palmas` | Tropical San Francisco — guns, sun, and a very long draw distance. |
| 🛰️ | **The Vibeverse** | `/vibeverse` | Fly a survey ship through a procedural galaxy. Some stars are worlds you can land on; one of them shoots back. |
| 🏁 | **Vibe Kart** | `/kart` | Drift for mini-turbos, sling shells, take the hairpin shortcut. |
| ⛳ | **Vibe Golf** | `/golf` | 63 holes of physics golf, with portals, jetpacks and very silly balls. |
| 🧬 | **Genesis Bloom** | `/evolve` | Play a creature. Eat, mutate, survive the apex. |
| 🌍 | **Globetrotter** | `/globetrotter` | Dropped somewhere on the real Earth. Work out where you are. |
| 📍 | **Vibe GO** | `/go` | Pokémon-GO-shaped catching in the real world. Phone first. |
| 🍉 | **Fruit Ninja** | `/ninja` | Slice fruit in VR, or with a mouse. Chase the score. |

### Worlds

| | World | Where | What it is |
|---|---|---|---|
| 🛫 | **The Terminal** | `/terminal` | The front door. Stand in the sky with every world floating around you and pick one. |
| 🏝️ | **Vibe Island II** | `/island-2` | A floating archipelago — a carved lagoon spilling into the clouds, islands you can fly underneath. |
| 🛩️ | **Seafair 2117** | `/seafair` | Future Seattle on Seafair weekend. Hydros, Blue Angels, and something alien holding the Space Needle. |
| 🏙️ | **Vibe City** | `/city` | Jetpack a neon district. Multiplayer, NPCs, star runs, and Vibey to talk to. |
| 🏝️ | **Vibe Island** | `/city?spawn=island` | The magically weird world in the sky — Jerry, the SnackFe cafe, the zipline, the rideable zeppelin. |
| ⛷️ | **Powder Peak** | `/city?spawn=ski` | Carve real slopes, ride the gondola, warm up at the Vibe Lodge. |
| 🌙 | **The Moon** | `/city?spawn=moon` | A tiny landable moon. Touch down on the pad and plant a flag. |
| 🧭 | **Island Explorer** | `/island-explorer` | Pick a character and a world, then walk, run and jump around it. |
| 🗺️ | **Healdsburg Village** | `/welcome` | Where this started — the real Healdsburg map with Vibey, Unit-7, choppers and spawnable worlds over real streets. |

### Places to be

| | Place | Where | What it is |
|---|---|---|---|
| 🪩 | **EDM Town** | `/edm-town` | Low-poly neon festival town — lasers, a dancing crowd, photo mode, a guestbook. |
| 🌌 | **Space Outpost** | `/space` | Vibey 2.0's late-night show on a floating asteroid, with the alien next door. |
| 🌱 | **Memory Garden** | `/garden` | Walk among planted memories and the outdoor art fair. |
| 🖼️ | **Fractal Museum** | `/museum` | A walkable, Seuss-flavoured gallery of famous fractals. |
| 🛋️ | **VIBE World** | `/world` | An always-on room that AI agents join over HTTP and live in. Drop in and see who is home. |

### And the rest of the app

`/game` (the index) · `/` (the 3D hub) · `/lobby` (~60 characters and vehicles) ·
`/character-select` · `/times` (a newspaper written nightly by the loop) ·
`/coin` ($VIBE) · `/companions` (hatch an agent) · `/world-builder` ·
`/submit-world` · `/about`

## The "and friends" part

- **[Anshu Chimala](https://github.com/achimala/TheLongSilence)** wrote THE LONG
  SILENCE, the procedural space game that became `/vibeverse`. It is vendored
  under MIT in `src/longsilence/`, licence and all, and that directory's README
  documents exactly what was changed and why.
- **Anyone can add a world.** `/submit-world` puts it in front of the hub, and
  approved submissions appear on the landing page next to the official ones.
  `/world-builder` will even write the prompt for you.
- **The characters** come from [Quaternius](https://quaternius.com/) packs
  (CC0), with props from [Meshy](https://www.meshy.ai/) — see the asset notes
  further down.
- **The code** is written with Claude Code, Cursor and Lovable, and reviewed by
  a human who has to look at every frame before it ships. `main` deploys, so
  every world in that list is live the moment it lands.

## How it is built

One Vite + React SPA, 53 routes, ~343,000 lines. Each world is a nearly
self-contained engine in its own directory under `src/`; under 1% of the code
is shared between them. Every destination is declared once in
`src/worlds/registry.ts`, and the nav, the picker, `/game`, the 3D hub and the
passport are all views of that one list.

**[ARCHITECTURE.md](./ARCHITECTURE.md)** is the full map: what is in here, how
the ten engines fit together, the numbers, and the honest debt.

Also worth reading:

- **[CLAUDE.md](./CLAUDE.md)** — the working rules. Push straight to `main`,
  verify before pushing, and the contract every new world follows.
- **[WORLDBUILDING.md](./WORLDBUILDING.md)** — everything learned building the
  map-based village world, distilled. Still the best guide to the Mapbox +
  Three.js half of the codebase.
- **[src/longsilence/README.md](./src/longsilence/README.md)** — how to vendor
  somebody else's standalone game and turn it into a route.

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

- Every line here is AI-written and human-directed — Lovable.dev, Cursor and Claude Code as the scaffolds, with the taste, the art direction and the "no, do it again" supplied by a person.
- A single `SpawnableLayer` is the generic Three.js → Mapbox bridge; adding a new world is one entry in the `spawnables` list in `MapView.tsx`.
- Everything is anchored to real Healdsburg lng/lat, so Vibey, the helicopter, and the floating island all share the same coordinate system as the live map underneath.

## Tools, references, and inspiration

This is also a personal repository for figuring out how to build immersive, beautiful worlds on the web. Below is the toolkit and reading list I keep coming back to.

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
