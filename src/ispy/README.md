# I Spy

A tribute to the Geometry Dash level of the same name, in two dimensions, at
`/i-spy`.

The original's idea is not "hard jumps". It is that **you cannot trust your
eyes**: the screen is packed with decoration drawn exactly like the things that
kill you, so the level cannot be read on sight — only learned. Everything here
serves that one idea.

## The files

| file | what it owns |
| --- | --- |
| `types.ts` | the vocabulary. One grid of 1×1 blocks, four modes, one `decoy` flag |
| `physics.ts` | `step()` — the entire simulation, as one pure-ish function |
| `build.ts` | authoring helpers, and the jump arithmetic every pattern is built on |
| `level.ts` | the level: six movements, then one pass of paint over all of them |
| `render.ts` | 2D canvas. Never told which objects are real |
| `audio.ts` | the soundtrack, synthesised, so the strobe can be locked to the beat |
| `bot.ts` | a solver. Proves the level is possible, and plays the title screen |
| `engine.ts` | clock, input, attempts, checkpoints, the spy pulse |

## Three rules that are load-bearing

**1. The renderer does not know what is real.** `drawObject` draws a decoy
spike with exactly the code that draws a lethal one — same fill, same outline,
same magenta core. The moment those two paths differ by a pixel this stops
being I Spy and becomes a normal level with clutter in it. The only exception
is the spy pulse, and it is deliberate.

**2. `step()` reads nothing outside its arguments.** That is what lets `bot.ts`
run thousands of speculative futures per second through the same code the
player is playing. A level authored blind cannot be playtested honestly — "I
couldn't do it" and "it can't be done" look identical from the chair — so
`src/test/ispy.test.ts` flies the bot end to end and fails the build if it
cannot finish. **If you edit `level.ts` and that test goes red, the level is
broken, not the test.**

**3. Everything runs at 1×.** A 1× cube jump is 2.6 blocks tall and covers
5.21, which puts a ground spike inside the arc from 0.56 to 4.65 blocks past
takeoff. Every pattern in `level.ts` is placed against that window (see
`JUMP_WINDOW`). Introduce a speed portal and the arithmetic in the comments
stops being true everywhere.

## The spy pulse

Three per attempt, `E` or right-click or the eye button. For 1.6 seconds every
decoy within an expanding ring drops to ~12% opacity and everything that can
actually kill you gets a bright outline.

It exists because the alternative is a level whose only teacher is death, and
because "spend a limited resource to see the truth" is a better answer to *I
Spy* than "memorise it or leave". Nothing lethal is ever drawn at less than 6%
opacity, so a pulse is a shortcut through the learning, never the only way.

Practice mode is the other concession: instead of restarting, it rewinds you
about a second, to one of the rolling checkpoints the engine keeps whether or
not practice is on.

## Capturing frames

```
node scripts/ispy-shot.mjs                    # contact sheet of all six movements
node scripts/ispy-shot.mjs 534 out.jpg        # one frame at block 534
node scripts/ispy-shot.mjs --run              # …and play the level through for real
```

The script boots the route with `?shot`, which hides the menu and HUD and
exposes the engine on `window.__ispy`. Two things it does that matter:

- **It seeks to blocks with clear ground.** `debugSeek` drops the player where
  you ask; ask for a block with a spike on it and you photograph a death and an
  attract-mode restart instead of the section you wanted.
- **It pauses before the shutter.** Grabbing a PNG out of a headless browser and
  re-encoding it takes seconds, and without `debugPause` the level has run on —
  and usually died — by the time the frame is written.

`--run` is the end-to-end check: it clicks the real title button, then hands a
real attempt to the bot and waits for the finish screen. vitest proves the
level is possible; that proves the page is.
