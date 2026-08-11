# COIL

Slither, at `/coil` (and `/slither`, `/snake`, `/worm`).

Nobody here is too big to kill. You cannot stop and you cannot reverse — only
turn, at one fixed rate, however long you get — so the whole game is getting in
front of somebody and letting them run into you.

## What makes it part of the vibeverse

**The character you bought in the shop rides the front of your snake**, and so
does everybody else's. The head is the shop's own portrait, the body takes its
colour from the same character spec, and the leaderboard is a list of names you
already know. Swapping face on the title screen writes through the same `equip`
the shop uses, so the city, the karts and the shelf all agree with you a second
later.

That is also why the bots are drawn only from characters *with* portraits: a
blank head next to Sable reads as a bug rather than a choice. Somebody wearing
one of the sixty free GLBs still gets a face — their character's own emoji on a
disc in their accent colour — which is legible at any size and is never a broken
image box.

## The map of the directory

| file | what it owns |
| --- | --- |
| `config.ts` | Every number, each with a sentence saying what it buys. |
| `body.ts` | The trail. The one genuinely interesting data structure here. |
| `types.ts` | Plain data. |
| `rng.ts` | Seeded mulberry32, so an arena lays out the same way twice. |
| `grid.ts` | Uniform grid over *body points*, not snakes. |
| `roster.ts` | Who is in the arena, and what they look like. The wardrobe hook. |
| `sim.ts` | All the rules. Knows nothing about a canvas. |
| `ai.ts` | The other twenty-two: a fan of candidate headings, scored. |
| `render.ts` | Canvas 2D. One stroke per snake, plus a face. |
| `audio.ts` | Web Audio, synthesised. |
| `engine.ts` | Loop, input, and the wire to React. |

## Four things worth knowing before changing anything

**A body is where the head has been.** Only the head is simulated. `body.ts`
keeps the trail with a cumulative arc length per point so "400 pixels behind the
head" is a binary search — and it has to be, because the spacing between points
is *not* uniform: a boosting snake lays them down almost twice as far apart, and
code that assumed uniform spacing would quietly shorten every boosting snake's
hitbox.

**Only `lengthOf(score)` of the trail is body.** Everything past that is history
the renderer and the collision pass both ignore. If you are writing a test that
lays out a body by hand, give the snake a score long enough to own the line, or
the far end of it is not there.

**A snake never collides with itself.** Crossing your own line is legal here
exactly as it is in the game this is modelled on — a genre where turning too
hard kills you is a genre nobody plays twice.

**Deaths recycle rather than accumulate.** A corpse becomes orbs worth most of
what it was carrying, and the snake resets to the starting length. So the field's
total score is a balance, not a ramp; asserting that it rises is asserting about
the weather.

## Verifying a change

`npm run typecheck && npx vitest run src/test/coil.test.ts` covers the rules.
Neither can tell you whether anything reached the screen:

```
node scripts/coil-check.mjs /coil out.jpg          # desktop
node scripts/coil-check.mjs /coil out.jpg --phone  # 390×844, touch
```

It presses play, steers, boosts, and reports console errors, whether the frame
has any colour in it, and the live HUD — plus, on a phone, whether letting go of
the glass leaves you still travelling.

`/coil?shot` hands the controls to the bot brain for the world-card capture, and
`?probe` exposes the engine without taking the controls, which is what the check
script drives.

## Not here yet

Rooms. BLOB grew a multiplayer layer (`src/blob/net`) that would port more or
less intact — sender authority, host-owned bots, a room code for the seed — and
the sender-authority argument is *easier* here, because the only thing that
crosses is "my head touched your body" and the victim can be told rather than
having to agree. Nobody has asked for it yet.
