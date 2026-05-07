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
