# Vibe Francisco — `src/frisco/`

Downtown San Francisco as a toy you can walk and fly around, at `/frisco`.

There is a photoreal San Francisco next door in `src/sf/`, and the two share an
origin (Montgomery & Market) and a coordinate convention (+X east, +Z south,
Y up, metres) and nothing else. Reading one before working on the other will
mislead you: almost every decision here is the opposite of the one there, on
purpose.

## The one thing to know

**It is a diorama, not a simulation.** Every building is generated once, at
load, into a handful of merged meshes, and then never touched again. There is
no chunk queue, no level of detail, no streaming budget, no impostors and no
temporal anything.

That is a direct response to what `/sf` cost: its glitching — the thing this
world was commissioned to avoid — came out of the streaming machinery, not out
of the geometry. Chunks arriving late, tiers cross-fading, impostor tiles
blinking. None of that machinery exists here, so none of that class of bug can.
A city you can hold in memory cannot change while you look at it.

The price is a hard ceiling on size. The map is 3.4 × 4.4 km and about 750 000
triangles resident, and that is close to the limit of what this approach will
carry. If it ever needs to be bigger, that is a rewrite, not a tuning pass.

## The files, in dependency order

| file | what it owns |
| --- | --- |
| `map.ts` | **Where everything is.** The projection, the bounds, the two street grids, the hills, the shoreline, the districts, the open spaces, the landmark sites, the spawns, and the camera's clip planes. Every other file asks it questions and none of them store a position. |
| `look.ts` | The whole art direction. The palette, the toon ramp, the two material constructors, and the inverted-hull outline. **Nothing in this world has a texture.** |
| `batch.ts` | Geometry accumulation into growable typed arrays. `box`, `bandedBox`, `gable`, `cylinder`, `ribbon`, `quad`. |
| `city.ts` | Builds the ground, the streets, the pavements, the blocks, the trees and the bay, once. Returns five meshes and a collider list. |
| `landmarks.ts` | The twelve buildings that make it San Francisco, by hand. |
| `collision.ts` | A uniform grid over the colliders. |
| `player.ts` | Walking, jumping, the jetpack, the third-person camera, the Vibeverse character rig. |
| `input.ts` | Keyboard, mouse and two thumbs. |
| `life.ts` | Cars and boats — the only things that move by themselves. |
| `play.ts` | The logbook, the coins and the Market Street course. |
| `sky.ts` | The dome, the clouds, Karl the fog, and the three lights. |
| `engine.ts` | The renderer, the loop, the teardown, and the `window.__frisco` debug surface. |

## Things that have gone wrong here, and will again

Every one of these was a day or most of one. They are documented at the site of
the fix as well; this is the index.

**Winding.** Six separate times. The water fan, the trees, the sky dome, half
the Transamerica's faces, Lombard's switchbacks, and — worst — two of the four
walls of *every* banded building in the city. Back-face culling means an
inside-out face is not a wrong face, it is a missing one, and a city missing
its north and west walls looks like a city that has not finished loading. If
something is invisible from one side, check the winding before anything else.
`batch.ts` now derives it from `up × n` in the two places it used to guess.

**Anything hand-written in GLSL.** A raw `ShaderMaterial` opts out of skinning,
of the logarithmic depth buffer, and of colour management, and this world needs
all three. The outline shader had all three bugs at once and the visible
symptom was *the sky is black* — an unskinned hull of a 38×-scaled character
rig is a seventy-metre black shape at the rig's origin, and it engulfs the
camera. Prefer `onBeforeCompile` on a stock material. If you must write a
shader, include `logdepthbuf_pars_*`, `logdepthbuf_*` and `colorspace_fragment`.

**The depth range.** `logarithmicDepthBuffer: true` is not optional and it is
not a nicety. A 4 km world with a 0.4 m near plane puts everything past a
hundred metres into the last fraction of a percent of a conventional depth
buffer, and on a renderer without 24 bits to spare the entire city collapses to
one depth value and vanishes. The symptom is a black screen with slivers in it,
which is indistinguishable from "the city was never built".

**The gazetteer drifting out of the bounds.** Districts, spawns, open spaces,
landmarks and the seawall are five lists of coordinates, and `BOUNDS` is four
numbers somewhere else. They *will* disagree, and the failure is silent: the
generator never visits those coordinates, so it is a place you can be sent and
cannot stand on. `friscoMap.test.ts` walks all five against the bounds.

## Verifying a change

`npm run typecheck` and `npm run build` catch nothing that matters here. The
tools that do:

```
node scripts/frisco-shot.mjs <outDir> card,downtown,waterfront,market
node scripts/frisco-shot.mjs <outDir> landmarks     # all twelve, one each
```

The landmark tour is the only way to see that a landmark is inside out, sunk
into a hill, at the wrong scale, or simply not built — every one of those reads
as "a slightly odd blob on the horizon" from anywhere else. It also prints the
triangle count and the draw calls, which is what tells geometry that was never
built apart from geometry that was culled.

`FRISCO_JPEG=src/assets/worlds/frisco.jpg node scripts/frisco-shot.mjs /tmp/x card`
recuts the card art.

`window.__frisco` is the debug surface the harnesses drive: `stats`, `player`,
`setPose`, `goTo`, `landmarks`, `show(layer, on)`, `setFog`, `setShadows`,
`setLights`, `startCourse`, `playState`, `raw`. Layer toggling is how most of
the bugs above were finally localised — "which mesh is that black thing in" is
one call and not an afternoon.
