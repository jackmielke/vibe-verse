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
├── DETAIL      ← streets, props, interiors, crowd, traffic, vehicles,
│                 activities, weather, launchsite
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
| `crowd.ts` | pedestrians on the nav graph — families, dogs, civic robots |
| `traffic.ts` | skycars on their lanes and the ring tram |
| `vehicles.ts` | the skiff, the glider, the lifter and the rooftop flyers |
| `interiors.ts` | the rooms you can walk into |
| `spire.ts` | The Meridian: one whole tower, its lobby, its lift and its sky deck |
| `launchsite.ts` | the spaceport on the snow, and the rocket that leaves it |
| `activities/` | races, courier runs, the photo hunt, the collectibles |
| `weather.ts` | the weather cycle, snow, cloud banks, birds, the aurora |
| `lighting.ts` | sun, shadows, the day cycle, what switches on at dusk |
| `postfx.ts` | the one place in this world that tone maps |
| `flight.ts` | the body — City's physics, in a function you can test |
| `camera.ts` | the third-person rig |
| `collide.ts` | every system's boxes and decks, in one grid |
| `minimap.ts` | the plan, drawn in 2D canvas rather than by a second camera |
| `audio.ts` | wind, jets, the city, and a pad that never resolves |

## The one tower you can go up

Twenty-three towers in the Spires and, for a long time, not one of them had an
inside. `spire.ts` builds a single tower end to end — **The Meridian** — and
`interiors.ts` carries it, because from the engine's side it is still one
interiors system. It claims its lot the way the café and the gallery do, so
`buildings.ts` leaves the footprint alone and the whole building, facade
included, is this file's.

The lot is chosen **by a rule and never by a coordinate**: the tallest `tower`
lot whose own footprint will hold a lobby. Both halves matter — height,
because a lift is only worth building if the ride is worth taking, and the
footprint, because two thirds of the towers here stand on wedges four metres
wide at the door. Reseed `cityplan.ts` and the tower moves with it.

**The lift is a `Deck` whose `y` changes, and nothing else.** There is no ride
mode, no fade and no teleport: `flight.ts` looks support up from
`prevY + CLIMB`, so a floor that rose less than 0.62 m since the last physics
step picks the body up on its own. `dt` is clamped to 0.05 s, which puts the
naive limit at 12.4 m/s — measured, not reasoned: 12.4 carries the body and
13.0 leaves it at the bottom of the shaft. The car caps its rise at 0.45 m
*per frame* as well, so the invariant holds whatever the clock does.

Three things about it that are not obvious and are load-bearing:

- **Down is not up.** A rising floor pushes a body; a falling one just leaves,
  and the body free-falls after it and sags `u²/2g` behind — 19 cm at 3 m/s
  and 1.8 m at 9. So the descent, and only the descent, sets the body onto the
  floor it is standing on. It cannot move anybody through anything and it does
  nothing at all on the way up.
- **The car is drawn a frame behind its own deck.** Systems update after the
  body has already stepped, so the body is always standing on the deck as it
  was one frame ago. Draw the car at the new height and the character rides
  eighteen centimetres sunk into its floor; draw it where the deck was and the
  two agree exactly, with no correction of any kind.
- **Every floor in the tower is a rectangle with the shaft cut out of it.** A
  slab across the shaft at the lobby ceiling is a floor the rising car puts
  the player onto and then leaves, and the ride ends nine metres up.

The tower is *solid* between the lobby ceiling and the sky deck — not because
anybody walks in there, but because the camera boom does, and a lens parked
inside a hollow tower gives you a black frame with the player two metres away
behind a wall. That does not read as a collision bug when you are looking at
it; it reads as the world being broken.

`node scripts/empyrean-shot.mjs meridian | lobby | lift | skydeck | glassfloor`
photographs all of it. Those five are given in the *tower's* own frame and
resolved in the page from `window.__empyreanLift`, for the same reason the lot
is chosen by a rule: a hardcoded pair of coordinates is a photograph of
whatever ends up standing there instead. `lift` also drives the car to a
height first, because under this container's rasteriser riding it takes eleven
real minutes.

## The two things that are not on the island

**The flyers.** Seven small aircraft, six on rooftop pads and one on the Halo
apron. The apron one exists because "work out the jetpack first" cannot be
the price of a first flight. They cannot be flown badly, and that is a design
constraint rather than a nicety: throttle is a setting that stays where you
leave it, roll self-levels, altitude holds, and two look-aheads mean that
pointing one at a tower and holding W ends with you on the roof. No stall, no
fuel, no damage, no landing score. The pads are chosen by a rule over the
plan — the tallest `block` lots, scored by clear roof, one per sixth of the
compass — so they survive the plan changing and do not all end up in one
district.

**The launch site**, 1.87 km out on the snow at bearing 244°. It was built at
2.2 km first and moved *in* after somebody looked at it: the snow is only
flat to about 1900 m, so further out a 180 m apron needs forty metres of
earthwork and reads from the deck as a second floating slab — in a world
whose entire subject is a floating slab. Distance was the wrong thing to
spend the picture on. At 1.87 km the apron lies flat, a dark oval on white
snow, which is the most legible thing there at that range; and 244° is 45°
off the sunset, so the stack is three-quarter backlit.

The cycle is a pure function of time, the way `weather.ts`'s is, so a test
can look an hour ahead without simulating anything. Fifty-five per cent of it
is a complete stack sitting still, which is what makes it worth watching for.
The flight path is monotone-interpolated because Catmull-Rom overshot the
catch and swung seventy metres of booster through the launch mount twice a
cycle.

`launchsite.ts` re-derives `terrain.ts`'s ground height rather than importing
it — a system may not import another system — and `empyreanLaunch.test.ts`
imports both and asserts they agree over a four-kilometre grid. That test is
the only thing standing between a retune of the ranges and a pad hanging in
the air.

## The hour and the weather are the player's

The world has had a full day cycle and five weather conditions since it was
built, and for a long time the only thing that could reach either was a debug
hook meant for a screenshot script. `EmpyreanSkyPanel` is the control: six
hours plus a slider, five conditions, and **Live** for each — which is a
first-class choice and not the absence of one, because the world's own clock
dwells near the sunset it was painted at and that is the best thing it does
unattended.

- **Picking an hour sweeps, it does not cut.** `DAY_SWEEP_RATE` is a constant
  0.17 of phase a second, so a nudge is instant and noon-to-midnight is a
  three-second time-lapse with the shadows swinging and the lamps coming on
  inside it. An ease-to-target was tried and crawls at the end, which on a sky
  reads as the renderer struggling.
- **It takes the short way round the clock.** Pick dawn from the small hours
  and the naive version runs forwards through the entire day.
- **The chips read the world, not the last button pressed.** Weather takes
  half a second to arrive and the hour takes seconds; the panel highlights
  what `EmpyreanState` says is true now. During a sweep no hour is lit, which
  is correct — the world is between them.
- The choice is in `localStorage` under `empyrean.sky` and is applied *before*
  the first frame, so the world does not open at its own sunset and then
  visibly lurch to midnight.

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
- **The promenade rings are a skirt, not a superstructure.** Three rings with
  sixty metres of overhang turned the island into a multi-storey car park with
  a town on the roof and hid the rock — which is half the silhouette — from
  every angle. Two rings, sixteen out and thirty-two down.
- **Rock is matte.** The keel's grooves were a 40% shading swing on top of a 4%
  geometric flute; raked by a low sun, four hundred metres of cliff read as a
  ring of polished golden columns holding the city up. The shape does the work.
- **`DECKS` has changed length twice**, and both times something indexed it by
  hand. Derive from the array. It is `as const` so the type checker will catch
  the read past the end — which is the only reason the last one was not an
  undefined dereference on the first frame.
- **A 1-D hash on two indices clumps.** The towers came out quilted in 5–20 m
  patches because lit windows were picked with `hash(x*31.7 + y*7.3)`;
  neighbouring bays land close together in the input. Anything indexed by
  (bay, floor) wants a 2-D hash.
- **A blocker is a floor, so it has to end where the building does.** A
  tapering spire's crown was given one box at the *shaft's* width all the way
  to the tip: thirty metres of clear air you could stand on, several metres
  out from a wall that had visibly sloped away from under you. Every existing
  check passed — the box was finite, positive, on the island and the right way
  up, and the tower drew perfectly. There is no cheap test for this: the
  meshes are hollow shells, so "is there geometry here" answers *no* for the
  inside of every solid building, and a raycast against three hundred thousand
  triangles with no BVH is not a unit test. Emit the boxes from the same
  polygons the geometry is lofted from, and if you cannot, look at it.
- **Skybridges were tried, blamed for a screen-filling black rectangle, and
  parked for a day. The rectangle was never theirs.** Nine glass tubes
  between the tower crowns went in; the city grew one hard-edged near-black
  rectangle occluding everything in a sixty-degree cone; the geometry was
  rewritten end to end — `boxAt` on the glass bucket, then `prism` with the
  pen's own base, span and seed — and the artefact did not move by a pixel.
  That was the clue, and it was read the wrong way round. The artefact did
  not change when the geometry changed because it never came out of the
  geometry.

  Where it does come from, measured rather than argued. Freeze the camera at
  `warp(0, 980, 300); look(0, 0.30); dist(24)` — 980 m over the Spires,
  looking down — and it is there every time, 696 × 546 px of flat black in a
  1100 × 620 frame, in a fresh Chromium, on a clean checkout, over four
  separate sessions. Then hide one system at a time from that same frozen
  pose, in one page load, with the same timing for every frame:
  `hide("interiors")` is the only one of the twelve that takes it away, and
  showing interiors again brings it straight back. It arrived with The
  Meridian; the build before that one does not have it.

  Three measurements are worth re-using on the next one of these, and the
  first two are the ones that cost the most to get:

  - **`hide("buildings")` does not remove it — it makes it *bigger*.** At the
    aerial pose the rectangle grows from 546 px tall to 592, because towers
    had been drawing over its lower edge. At `warp(0, 700, 640)` — the
    skyline pose, where the city is between you and it — hiding the buildings
    makes it *appear*, 696 × 482 at (202, 0), repeatably. So it is behind the
    city, at a depth, being depth-tested normally, and `buildings.ts` is
    nowhere near it.
  - **Its edges do not converge.** The left edge sits at x = 202 at y = 60
    and at x = 202 at y = 530 alike. Under this camera's pitch a world-
    vertical edge leans about ninety pixels across that span. Take the two
    together and it is geometry, at a depth, whose vertices are placed
    somewhere other than in world space.
  - **The colour tells you nothing, and this is a trap worth naming.** The
    fill comes out (20, 9, 26), which looks like a smoking gun and is not:
    `postfx.ts`'s shadow lift maps *both* an unwritten pixel and a surface
    returning `vec3(0.0)` onto the same violet. Nor is the one-pixel edge
    evidence of anything — `world.ts` asks for `antialias: false` and the
    post chain is single-sampled, so every edge in every frame here is one
    pixel hard.

  The old note said `hide("buildings")` made it vanish, and that is the
  useful half of the lesson: the thing is strongly pose-dependent, so a
  single frame with a system switched off is not a control unless the same
  frame with it switched on has the artefact in it. Toggle it twice.

  **The bridges are in, and they are not that.** Seven of them, chosen by
  nearest-unused-neighbour over the built tower lots so a reseed of the plan
  moves them with the towers: 58 to 85 m long, decks at 777 to 813 m, +2,326
  triangles at the high tier and +2,298 at the low, and the same four draw
  calls. The rest of what they cost to get right is in the block comment over
  `buildSkybridges`. The one worth knowing from out here is the floor: it is a
  chain of squares whose half-diagonal is exactly the deck's half-width,
  because `world.ts` stands the player on axis-aligned boxes, and one box
  around a tube lying at forty degrees to the axes is metres of thin air you
  can stand on beside a wall you can see straight through — which is the
  tapering spire's crown, above, arriving from a different direction.
- **Test the world, not just the modules.** `src/test/empyreanWorld.test.ts`
  builds every system, steps it, and looks for the failures whose symptom is a
  black screen rather than an exception: a NaN in a position buffer (one
  collapses the bounding sphere and the mesh silently stops drawing), geometry
  left in local space, a built lot that is hollow. It found the ring tram
  updating its state perfectly and never once moving its geometry.

## What it costs

Measured with `PERF_ENTER=Arrive node scripts/route-perf.mjs /empyrean`, on
the same container and in the same session as the two worlds it is worth
comparing against. Draws, triangles, programs and texture memory are exact —
they are counts of what the page asked the driver to do. The frame rates are
SwiftShader's and are a **ranking only**, never a prediction.

| route | draws | triangles | programs | textures | fps (relative) |
| --- | --- | --- | --- | --- | --- |
| `/empyrean` | 178 | 2.76 M | 59 | 23 MB | 0.9 |
| `/city` | 473 | 3.28 M | 36 | 16 MB | 0.5 |
| `/sf` | 251 | 1.91 M | 27 | 9 MB | 0.6 |

Fewer draw calls than either, and faster than both on the rasteriser that
ranks them. Vibe City ships and is playable, so this is inside the envelope
this repo already holds. The low tier builds about 1.1 M triangles against
the high tier's 2.6 M, which is what `empyreanBudget.test.ts` pins.

**`route-perf` had to be taught to click.** It clicks the middle of the
viewport once, which misses this world's Arrive button, so the first
measurement came back *60.1 fps, 0 draws, 0 triangles* — a perfect score for
a title card, printed as `ok`. `PERF_ENTER` names the button, and a live GL
context that drew nothing now prints as `menu?` rather than as a fast world.

## Card art, and why there is no moving one

`node scripts/route-shot.mjs "/empyrean?shot=1" src/assets/worlds/empyrean.jpg`.
The `?shot` camera is a fixed composition from off the south rim; it is not an
attract mode and nothing plays itself in it.

`route-gif` was run rather than reasoned about, and it refused:

    400x224 · 4 frames (4 distinct) · 3.85s · 1.0 fps
    REJECTED: 4 distinct frames, need 8.

So this world keeps its still, which is the right answer — but not quite for
the reason the recorder gives. Every frame it managed to capture *was*
distinct; it only captured four, because SwiftShader renders this world at
about one frame a second and the clip is three seconds long. The recorder
cannot tell "nothing moves here" from "the rasteriser is too slow to sample
it", and on a machine with a GPU this might well pass. If somebody wants a
moving card, record it somewhere with hardware and let the eight-frame floor
mean what it says.

## Verifying

`npm run typecheck` (never bare `tsc --noEmit` — see the root `CLAUDE.md`),
`npm run build`, `npx vitest run src/test/cityplan.test.ts src/test/empyrean.test.ts`.

Then open it. **`scripts/empyrean-shot.mjs` is the tool** — it drives the
world's own debug hooks (`__empyrean.warp`, `.look`, `.dist`, `.day`,
`.weather`, `.freeze`, `.hide`) rather than synthesising mouse drags, so a
viewpoint is three numbers in its table instead of a sequence of inputs that
breaks the moment the camera is retuned.

```
node scripts/empyrean-shot.mjs                      # every viewpoint
node scripts/empyrean-shot.mjs bazaar .shots/a.jpg  # one, eye level in a street
EMP_DAY=0.02 node scripts/empyrean-shot.mjs skyline # at night
EMP_HIDE=props,crowd node scripts/empyrean-shot.mjs air   # bisect an occlusion
```

Two things it learned the hard way. **Freeze before you warp** — gravity undoes
a warp inside the settle window, so every aerial viewpoint used to be a
photograph of the pavement the player landed on. And **wait for
`window.__empyrean`, do not click once and hope** — under load the title card
photographs about a third of the time, and a shot of the menu looks like a
finished frame of a world that is not there.

Neither a green build nor a green test suite has ever caught this world
looking wrong.

**The prompts are checked in a browser, not only in a test.** Warp to each
interactable and read `__empyrean.state().prompt`: four races, two courier
stations, the photo hunt, the Market Hall and the tram board all offer
themselves where they should. The tests cover what happens after you press
the key; this covers the key being offered at all, which is a different
failure and a sillier one.
