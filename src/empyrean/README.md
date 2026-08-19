# The Empyrean

A city of glass on a rock that never landed, six hundred metres over a frozen
lake, at the exact minute of a sunset. You fly it with Vibe City's jetpack, as
whichever character you already picked anywhere else in the vibeverse.

`/empyrean` (also `/floating-city`, `/skycity`).

## How this directory is arranged, and why

The engine is a dozen independent systems and one orchestrator. That shape is
not architectural taste — it is the only way a world this size gets built,
because it lets streets, buildings, props, crowds, traffic, lighting,
interiors, activities and audio be written at the same time by people who
never read each other's code.

The whole thing rests on **`cityplan.ts`**: where every street, block, lot,
door and nav node is, decided once, deterministically, in pure data with no
THREE in it. Everything else reads the plan. Nothing else invents geometry.
The first build had no plan — sixty boxes on a disc from a golden-angle spiral
— and the result had no streets, so no pedestrian had anywhere to walk, no
courier had an address to deliver to, and no shopfront had anything to face.

### The rule

> A system may import `types.ts`, `config.ts`, `cityplan.ts`, `three`, and
> shared helpers from `@/shared` or `@/lib`. **It may not import another
> system.**

Anything one system needs from another is either in the plan or arrives in the
`FrameContext`. The moment two systems import each other, twelve files become
one module with twelve files in it, and the next person cannot change any of
them alone.

### The two scene graphs

```
scene
├── sky.ts                     one inverted sphere, pinned to the camera
├── terrain.ts                 snow, ranges, and the lake
│   └── mirror  (scale.y = -1)
│        └── clone(true) of ▼
├── REFLECTED   ← keel.ts, buildings.ts      the island's silhouette
├── DETAIL      ← streets, props, crowd, traffic, interiors, activities
└── body + plume
```

`System.reflected` decides which one a system joins. The lake reflection is a
real mirrored clone of the REFLECTED group, so everything in it costs a second
draw — worth it for the rock and the towers, which *are* the reflection, and
not for eight hundred pedestrians who are four pixels each at a kilometre.

**A reflected system must drive every gradient from an attribute along the
object's own height, never from world Y.** Mirror a world-Y gradient and the
towers come out the right way up inside an upside-down reflection: subtly,
unplaceably wrong, and invisible until somebody looks at the lake.

## What is where

| file | owns |
| --- | --- |
| `config.ts` | the numbers the whole world agrees on — scale, decks, spawn |
| `cityplan.ts` | streets, blocks, lots, doors, districts, landmarks, nav graph |
| `types.ts` | `System`, `FrameContext`, `Interactable`, `EmpyreanState` |
| `world.ts` | the renderer, the loop, the systems list, teardown |
| `sky.ts` | the gradient, the stars, the clouds, the sun |
| `terrain.ts` | the snowfield, the ranges, the lake and its mirror |
| `keel.ts` | the rock under the city, the terraces, the parapet |
| `buildings.ts` | every facade on every lot, and the landmark structures |
| `streets.ts` | roadway, kerbs, pavements, crossings, plaza inlays, stairs |
| `props.ts` | lamps, benches, trees, stalls, awnings, banners, fountains |
| `crowd.ts` | pedestrians on the nav graph |
| `traffic.ts` | skycars on their lanes and the ring tram |
| `interiors.ts` | the rooms you can walk into |
| `activities/` | races, courier runs, the photo hunt, the collectibles |
| `lighting.ts` | sun, shadows, the day cycle, what switches on at dusk |
| `postfx.ts` | the one place in this world that tone maps |
| `flight.ts` | the body — City's physics, in a function you can test |
| `camera.ts` | the third-person rig |
| `audio.ts` | wind, jets, the city, and a pad that never resolves |

## The physics is not "like" Vibe City's, it is Vibe City's

`flight.ts` imports every constant from `@/lib/worldPhysics` — gravity 24, walk
7, run 16, cruise 22, boost 34, jump 11 — and uses the same 50 m/s² of thrust
and the same exponential easing City's page does. `src/test/empyrean.test.ts`
asserts each of those rather than leaving them to be felt for, because a number
that drifts still builds, still renders, and quietly stops being the thing the
world said it was.

## Things that were got wrong here already

Kept because each one cost a rebuild and would cost another.

- **The card art was fine while the world was unplayable.** Photographed from a
  kilometre away the first build looked finished. Opened and walked, the spawn
  was inside a tower, the camera inside a second one, and the entire first
  frame was a white wall — the tower fresnel is a silhouette effect and had
  been tuned only from the distant camera. *Open the route and look, on foot,
  every time.*
- **Proportions failed twice in opposite directions.** Towers at 250 m against
  a 300 m keel read as a saucer with glitter on it. Widening the rock to hold a
  shoulder past the terraces made a cauldron. The reference has a rim of decks
  with the rock starting immediately under it at nearly the same width, falling
  to a point longer than the city is tall.
- **The ranges are capped below the deck.** The first pass put 984 m mountains
  behind a 420 m island and the picture stopped being a city in the sky.
- **Clearance is metres, and on a radial plan that is a different number of
  radians at every radius.** Applying the innermost figure to a whole block
  over-clears its outer edge by the ratio of the radii; in the core that is
  nearly two, and the whole city came out as twenty-two splinters.
- **A doorstep is not a wall.** Blocks are held clear of the pavement and lots
  are inset inside blocks, so there are two or three metres of dead ground in
  front of every shopfront. `Lot.door` is the first walkable point outward;
  `Lot.frontMid` is the wall. Send couriers and pedestrians to the former.

## Verifying

`npm run typecheck` (never bare `tsc --noEmit` — see the root `CLAUDE.md`),
`npm run build`, `npx vitest run src/test/cityplan.test.ts src/test/empyrean.test.ts`.

Then open it. `node scripts/route-shot.mjs "/empyrean?shot=1" out.jpg` for the
card composition, and `ROUTE_SHOT_ENTER="Take off" node scripts/route-shot.mjs
/empyrean out.jpg` for what a player actually sees. Neither a green build nor a
green test suite has ever caught this world looking wrong.
