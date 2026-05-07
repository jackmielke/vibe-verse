# Edge Esmeralda

An interactive version of Edge Esmeralda overlaid on top of a real map. See what's happening nearby in the village, walk around as your community agent, fly a chopper or VTOL over the rooftops, and spawn animated 3D worlds — a floating island, a Death Star, a tiny animated Chinatown — into the sky and streets of Healdsburg.

The whole thing is a small experiment in engaging with the digital world in a novel, immersive way. Fully vibe-coded — more improvements to come.

## What's in here

- **Live village map** — Mapbox 3D buildings + custom Three.js landmarks (Plaza, Meditation Temple, Observatory) anchored to real Healdsburg coordinates
- **Vibey** — your community agent, hovering above the plaza. Tap to chat
- **Unit-7** — autonomous resident bot wandering the streets. Click his beacon to talk; he waves, dances, jumps, gives a thumbs up
- **Sky Patrol** — pilotable chopper + Nimbus VTOL that you can take controls of with the keyboard
- **Spawnables** — heavy GLB worlds that load on demand:
  - 🏝️ **Edge Island** — a lush floating world hovering 700m above the village
  - ⭐ **Death Star** — moon-sized space station spinning east of town
  - 🏮 **Tokyo Block** — a keyframe-animated micro-city a few blocks east of the plaza
- **Events + Community panels** — what's happening today, where, and who's there
- **Toggleable views** — Standard 3D dusk style and a Google-Earth–style satellite view, both with extruded 3D buildings

## Stack

Vite · React · TypeScript · Tailwind · shadcn/ui · Mapbox GL JS · Three.js (GLTF + Draco) · Supabase · Bun

## Running it locally

```bash
bun install
bun dev
```

Open <http://localhost:5173>. The Mapbox token is wired through `.env`.

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
