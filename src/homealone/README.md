# HOUSE RULES

A trap-laying home defence game. Route: `/house-rules` (`/home-alone` is where
it used to live and still opens it). The directory, the registry key and the
card art's key kept the first name; every word a player reads says House Rules.

It began as a film tribute with eight fixed trap spots you switched on. It was
rebuilt as its own game around one idea: **you lay the traps, anywhere, and a
trap is a direction and a distance.**

## The loop

1. **Plan.** A night starts with the doors shut, a box of parts and a countdown.
   Dotted lines on the floor show where tonight's intruders will walk.
2. **Raid.** They come in through the front and back doors on a schedule. Each
   walks to a valuable, picks it up, and carries it out of the door he came in
   by. If he gets out, he comes back for another, as rattled as he left.
3. **It ends** when everybody still coming has lost their nerve, or when there
   is nothing left to take. Three stars: kept something, kept everything,
   landed a chain of three.

You can keep laying traps during the raid. Every hit pays a part back.

## Why chains happen

`kit.ts` resolves every trap to a throw: which way, how far, sliding or flying.
`engine.advanceFling` then walks the body along that throw twelve centimetres
at a time and asks what it has just hit:

- another trap: that trap fires too, and the chain grows a link
- a wall: WALL SLAM
- somebody on his feet: BOWLING, and he inherits the chain
- the stairs: the throw is redirected down the flight, and landing a storey
  lower is a TUMBLE

Nothing is scripted. A springboard at the top of the stairs with three people
on the flight produced an eight-link pile-up the first time it was simulated,
which is why `linkScore` stops counting at six.

## The cast

`nights.ts`. Five people on two rigs: Gus (baseline), Lenny (quick), Skeeter
(fast, low nerve), Nell (takes visible traps apart in lit rooms, unless she is
busy or blind), Moose (thrown half as far, a lot of nerve). Each is a reason to
lay a different thing in a different place, and each night's brief card says
who is coming and through which door.

## Files

| file | what it owns |
| --- | --- |
| `kit.ts` | the eight traps, placing rules, chain maths, the scorecard. Pure |
| `nights.ts` | who comes when, the cast, the six valuables. Pure |
| `placed.ts` | what a laid trap looks like, the ghost, loot markers, route dots |
| `ai.ts` | the intruder: prowl, loot, grab, carry, hunt, search, disarm, down, flee |
| `engine.ts` | renderer, camera, the kid, the raid clock, and carrying thrown bodies |
| `levels.ts` | the nights as levels, plus the sandbox and two quiet modes |
| `house.ts` | the floor plan: rooms, stair ramps, doorways, the nav graph |
| `build.ts` | the geometry: walls with holes in them, furniture, the street, the snow |
| `characters.ts` | everybody, off one skeleton, with a coat colour and a scale |
| `textures.ts` | every surface and every face, drawn into a 2D canvas at boot |
| `christmas.ts` | the lights, the garland, the wreath, the icicles, all instanced |
| `banter.ts` | every line anybody says, in shuffled bags |
| `bricks.ts` | snowballs: a real projectile with a bit of aim assist (the file kept its name) |
| `audio.ts` | wind, boards, a furnace, the trap noises and two short original tunes |
| `ui/HomeAloneHUD.tsx` | the kit bar, valuables, the intruder list, the chain feed, touch controls |

## Things that are load-bearing

- **The house is one continuous scene and the stairs are real.** There is no
  "which floor am I on" flag: `groundAt()` takes the highest slab or ramp under
  you within a step of your feet. Intruders use the same floor.
- **Routes are by distance, not hops** (`pathBetween` in `house.ts`). The side
  yard joins the two doors in two hops, and a hop count sent a burglar round
  the outside of the house to reach a room across the hall.
- **The dotted lines are the AI's real choice.** `likelyRoutes` picks loot the
  same way `pickLoot` does, so what you plan against is what happens.
- **A snowball never wins a night.** It staggers. It only floors somebody who
  is stuck or blind, which makes it the finisher for glue and flour.
- **Being caught costs a heart, not the night.** Three hearts; you are put back
  in your room with a few seconds' head start.
- **Third person, with a boom that shortens.** `settleCamera` pulls the lens in
  whenever a wall gets between it and the kid's head, down to 0.45 m.

## Checking it

There is no GPU in the sandbox and this house renders at about a frame a
second there, so nothing can be judged by watching.

- `engine.settle(seconds)` steps the simulation at a fixed thirtieth of a
  second without drawing. A ninety-second raid takes a moment.
- `engine.spectator = true` makes the player invisible to the intruders, so a
  layout can be judged on its own.
- `node tools/homealone-play.mjs` runs whole nights that way and asserts on
  what the HUD would show: traps fire, chains form, loot is taken and dropped,
  hearts are lost, the quiet modes still finish.
- `node tools/homealone-shot.mjs <out.png> [level]` lays a few traps and takes
  a real frame, HUD included.
- `src/test/houseRules.test.ts` covers the pure half: placing, chain maths,
  scoring, the night table and the routes.

## Not verified

Balance was tuned against simulated raids with nobody at the controls. Nobody
has yet played a whole night by hand on real hardware, so how hard the later
nights feel with a kid actually running about is a guess.
