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

The price is a hard ceiling on size. The map is 3.4 × 4.4 km and about 1.2
million triangles resident across some sixty draw calls, and that is close to
the limit of what this approach will carry. If it ever needs to be bigger, that
is a rewrite, not a tuning pass — and anything added between now and then
should come with a number, the way `street.ts` and the bay windows do.

**Two things move without `dt` from the render loop, and neither is negotiable:
nothing at all.** Every animated thing here — traffic, the crowd, the boats, the
cable cars, the coins, the fog banks — steps on the loop's `dt`, which is what
makes `__frisco.freeze()` able to stop the entire city dead for a photograph.
Anything that reaches for `performance.now()` on its own breaks that.

## The files, in dependency order

| file | what it owns |
| --- | --- |
| `map.ts` | **Where everything is.** The projection, the bounds, the two street grids, the hills, the shoreline, the districts, the open spaces, the landmark sites, the spawns, and the camera's clip planes. Every other file asks it questions and none of them store a position. |
| `look.ts` | The whole art direction. The palette, the toon ramp, the two material constructors, and the inverted-hull outline. **Nothing in this world has a texture.** |
| `batch.ts` | Geometry accumulation into growable typed arrays. `box`, `bandedBox`, `gable`, `cylinder`, `ribbon`, `quad`. |
| `city.ts` | Builds the ground, the streets, the pavements, the blocks, the trees and the bay, once. Returns five meshes and a collider list. |
| `landmarks.ts` | The twelve buildings that make it San Francisco, by hand. |
| `collision.ts` | A uniform grid over the colliders, plus a two-entry `dynamic` list for the cable cars. Colliders are frusta, and some are elliptical. |
| `player.ts` | Walking, jumping, the jetpack, the third-person camera, the Vibeverse character rig. |
| `input.ts` | Keyboard, mouse and two thumbs. |
| `street.ts` | Lamp posts, signals, hydrants, benches, shelters, trolley wires. A budget problem, and documented as one. |
| `life.ts` | Cars, boats and nine hundred pedestrians — the things that move by themselves. |
| `cablecar.ts` | The Powell line: rails, two cars, and the only thing here you can ride. |
| `play.ts` | The logbook, the coins, three ring courses and the Grand Tour. |
| `audio.ts` | The entire soundtrack, synthesised, with no files in it. |
| `sky.ts` | The dome, the clouds, five times of day, Karl the fog, and the three lights. |
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

**A collider that is not the shape of its building.** Reported as "the physics
don't work on curved buildings", and exactly right: everything was a prism with
the base's footprint, so the corners of round towers and the taper of every
setback were floor with nothing underneath. Colliders interpolate between base
and roof and can be elliptical now, and `friscoCollision.test.ts` checks it
against the real nine-thousand-collider city. Every assertion in that file was
verified to *fail* against the old behaviour before being kept — a test that
passes both ways is worse than no test.

**Anything placed by arithmetic into a city built by arithmetic.** Ring courses,
spawns, coins: the maths is right and the result is inside a building. Three of
the Hill Climb's ten rings were in Nob Hill apartment blocks and the course was
simply unfinishable; the Fisherman's Wharf spawn was a courtyard with no way
out. Both are invisible from the air and in a screenshot. Place against
`roofOver` / `snapToStreet`, and check with `frisco-challenges.mjs`.

## Verifying a change

`npm run typecheck` and `npm run build` catch nothing that matters here. The
tools that do:

```
node scripts/frisco-shot.mjs <outDir> card,downtown,waterfront,market
node scripts/frisco-shot.mjs <outDir> landmarks       # all twelve, one each
node scripts/frisco-shot.mjs <outDir> spawn:wharf     # a real spawn, not a pose
node scripts/frisco-challenges.mjs                    # fly every course
node scripts/frisco-audio-check.mjs                   # the audio context lifecycle
FRISCO_TIME=night FRISCO_FOG=0.8 node scripts/frisco-shot.mjs <outDir> downtown
```

**Prefer `spawn:<key>` to a hard-coded pose for anything at street level.** A
pose is three numbers that were on a road on the day they were written, and the
city keeps getting denser; half the street shots in this repo's history ended up
inside a wall, which reads as a rendering bug and is not one.

`frisco-challenges.mjs` earns its keep on a class of bug nothing else can see:
the Hill Climb once had three of its ten rings inside Nob Hill apartment blocks.
Visible through the wall, unreachable, and the course silently never advanced.
Perfect from the air, perfect in a screenshot. You have to fly it.

The landmark tour is the only way to see that a landmark is inside out, sunk
into a hill, at the wrong scale, or simply not built — every one of those reads
as "a slightly odd blob on the horizon" from anywhere else. It also prints the
triangle count and the draw calls, which is what tells geometry that was never
built apart from geometry that was culled.

`FRISCO_JPEG=src/assets/worlds/frisco.jpg node scripts/frisco-shot.mjs /tmp/x card`
recuts the card art.

`window.__frisco` is the debug surface the harnesses drive: `stats`, `player`,
`setPose`, `goTo`, `landmarks`, `show(layer, on)`, `setFog`, `setTime`,
`freeze`, `setShadows`, `setLights`, `startCourse`, `nextRing`, `playState`,
`audioRunning`, `raw`.

Two of those are load-bearing for photography. **Layer toggling** is how most of
the bugs above were finally localised — "which mesh is that black thing in" is
one call and not an afternoon. **`freeze`** stops `dt`, which holds the traffic,
the crowd, the boats and the cable cars still: photographing something that
moves by posing the camera and waiting has a race in it that no amount of
waiting fixes.
