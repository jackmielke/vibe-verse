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
| `audio.ts` | the score — synthesised, through-composed, and the clock the strobe runs on |
| `bot.ts` | a solver. Proves the level is possible and its coins reachable, and plays the title screen |
| `engine.ts` | clock, input, attempts, checkpoints, the spy pulse |

## The music

Not the original level's track: that song belongs to the person who wrote it,
and shipping a copy of it here is not ours to do. This is an original piece in
the same idiom — F♯ minor, 120 BPM, i–VI–III–VII, sidechained
four-on-the-floor, a detuned saw lead through a dotted-eighth delay.

It is **through-composed, not looped**. The level is exactly 120 beats and its
six movements are at known beats, so the arrangement is written against those
same boundaries: the drop lands when the strobe section starts because both of
them start at beat 62.

| beat | movement | what the score does |
| --- | --- | --- |
| 0 | The quiet part | half-time kick, sub, filtered pad |
| 21 | I spy | snare, offbeat hats, the arp arrives |
| 42 | Mirror | sixteenth hats, the bass opens up |
| 62 | Strobe | the drop — lead, crash, everything |
| 80 | Green | breakdown, filter down, no lead |
| 98 | Everything | final drop, lead an octave up |

Everything but the kick runs through a `duck` gain node that the kick pulls
down and releases over 0.62 of a beat. That pump is most of what makes this
genre sound like this genre.

## One jump is one beat is five blocks

The spine of the level, and the reason `level.ts` is written in beat numbers
rather than x coordinates.

The soundtrack runs at 120 BPM, so a beat is half a second. A 1× cube jump
hangs for 0.501 s and covers 5.01 blocks. Round that to five and three separate
grids collapse into one — the music's beat grid, the level's block grid, and
the player's jump rhythm. Jump on a beat and you land on the next one, ready to
jump again; a run of hazards one beat apart is a run of jumps on the downbeat.

That is the difference between a level cut to its music and a level merely
played over one. It is also why there are no speed portals: a speed change
breaks all three alignments at once.

`b.beatSpikes(24, 2)` reads "on beat 24 the player jumps, and this is what they
jump over". The decoys are placed the same way, on the beat, because a decoy
off the beat is *audible* — the music would tell you which spikes were real and
the level would solve itself.

## What makes a decoy dangerous

Not being a spike. An unnecessary jump lands exactly one beat later, in time
for the next one, so jumping at a painted spike costs nothing — a level of
harmless decoys is a level with no teeth.

What makes a decoy lethal is what sits **above** it. Painted spikes on the
floor with real ones hanging at head height: walk through the lie and live,
jump the lie and die on the ceiling. It is the one trap in the genre where the
honest move is to do nothing, and the level plays it three times — once to
teach it, once mirrored (real floor, painted ceiling), and once with the rest
of the level shouting over it.

## Three secret coins

Off the safe line, and only kept if you *finish* the run holding them — the
original's rule, and the right one: a detour you did not survive did not
happen. Taking one after a checkpoint and dying loses it again.

Verifying them was the interesting part. "The coin sits near the line the bot
flies" is an estimate, and a bad one: a coin four blocks off the path might
need a detour that cannot be recovered from. So `canCollect` in `bot.ts` runs
the real solver with a coin-seeking policy — at each decision it scores both
options by simulating which future passes closer to the coin, takes the better
one, and still requires it to survive the search horizon. The test asserts each
coin is *not* on the safe line and *is* collectable by a run that then finishes
the level. It caught two bad placements: one coin sat exactly on the apex of a
jump you had to make anyway, and another was pinned against a tunnel roof in a
spot no survivable line reached.

## The cube lands flat

The cube used to spin at a fixed rate and stop wherever the arc ended, which
is usually on a corner and looks broken. It now **solves its spin from the
jump**: half a turn spread over exactly the air time that launch buys, so it
arrives at 180° — flat on a face. Land early on a platform and `settle()`
rotates the remainder onto the nearest flat face at 1100°/s.

`CUBE_SPIN` and `SETTLE_RATE` in `physics.ts`, and two tests hold it: one
jumps at four different hold lengths and requires every landing to be within
half a degree of a multiple of 90, the other checks a full-height jump turns
between 170° and 190°.

## Hitboxes

`HITBOX` in `physics.ts`, in Geometry Dash's own units — a block is 30×30 px
there and 1×1 here, so every number is the pixel figure over 30. Two boxes per
player as in the original: the **solid** box (30×30) stands on blocks and dies
on their sides, and the smaller **hazard** box (18×18, centred) is what spikes
test. A spike's own box is 12×18 at the base centre of its tile, not the whole
tile. That gap is why clipping the corner of a spike survives, and it always
has been.

## Ghosts, and the backdrop

Two different jobs, deliberately kept apart:

- **`ghosts()`** is the lie, and it only works if the decoys look like *level*.
  Everything it emits sits on the integer grid, at the sizes real objects come
  in, unrotated, in the section's colours — a decoy spike row is pixel-for-pixel
  a real spike row. Rows cap at three, because a longer one is not clearable and
  so reads as scenery and fools nobody, and patterns are spaced apart so
  neighbours do not fuse into one fourteen-spike wall no real level would
  contain.
- **`backdrop()`** is the atmosphere: big, soft, dim, slow, free to be as loose
  as it likes precisely *because* it is never mistaken for geometry. All the
  visual richness lives here so the play layer can stay legible.

An earlier version had one function doing both — randomly rotated, randomly
scaled shapes everywhere — and it read as confetti. Nobody mistakes a spike
tilted 37° and scaled 1.8× for a hazard, so nothing was being deceived; the
screen was just noisy.

## Checkpoints live in practice mode

Where the original puts them, and where they belong: a normal attempt is the
whole level or nothing. Turn practice on and eleven checkpoints appear — at the
mouth of each movement and halfway through the long ones, all on clear ground
you can be dropped onto. Crossing one banks the run; dying after it costs half
a second instead of a minute.

Two consequences worth keeping, both the original's rules:

- **Coins do not count in practice.** A run with checkpoints in it is not a run.
- **The banners are not drawn outside practice**, because outside practice they
  do nothing, and drawing an object that does nothing in a level about objects
  that do nothing is a joke at the player's expense.

Checkpoints are not colliders — `World` skips them entirely and the engine
watches the player's x against a sorted list, so the physics and the solver
never have to know they exist. Resuming from one also seeks the *score* to the
matching movement, so coming back in at 80% drops you into the final drop
rather than the filtered intro.

## Colours are computed, not authored

Three things the renderer works out from the palette rather than being told:

- **`inkFor`** picks the outline colour by measuring what is behind it. Every
  edge used to be stroked in the section's accent, which is fine on the black
  sections and invisible in the strobe — yellow on yellow.
- **`coreFor`** picks the spike's inner wedge from the spike's own fill, so the
  two tones always separate whatever the palette does.
- **`mix`** returns `#rrggbb`, and that is load-bearing: every other helper here
  parses with `hex`, so a `mix` that returned `rgb(…)` poisoned everything
  downstream with NaN. Since the section cross-fade runs its colours through
  `mix`, that bug meant the level drew with invalid colours for fourteen blocks
  either side of all six seams. A test now walks every block of the level and
  asserts the palette is parseable everywhere.

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

Checkpoints are the other concession, and the menu can turn both off.

## Capturing frames

```
node scripts/ispy-shot.mjs                    # contact sheet of all six movements
node scripts/ispy-shot.mjs 534 out.jpg        # one frame at block 534
node scripts/ispy-shot.mjs --run              # …and play the level through for real
node scripts/ispy-shot.mjs --checkpoints      # …and prove dying resumes correctly
node scripts/ispy-shot.mjs --phone            # …and shoot it on a portrait phone
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

`--checkpoints` proves the thing a screenshot cannot: it plays until three
checkpoints are banked, kills the player, and checks the run resumes at the
checkpoint — then does it again in purist mode and checks it does not.

`--phone` matters more than it sounds. A portrait viewport is where this game
breaks: fifteen blocks of height on a 0.46-aspect screen leaves four blocks of
warning, which is not a hard level, it is a broken one. The world is
letterboxed into a band of at least 1.62 aspect and the bars become where the
HUD lives.
