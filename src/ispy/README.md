# I Spy

A Geometry Dash level in two dimensions, at `/i-spy`.

It started as a tribute to the level of the same name, whose idea is that you
cannot trust your eyes — a screen packed with decoration drawn exactly like the
things that kill you. That is not what this is any more, on purpose and at the
owner's instruction. **Every spike here is a real spike. Every sawblade kills.**
The only scenery left is architecture, because nobody has ever mistaken a
building for a spike.

What the level is instead: sixty seconds cut to its music, where one jump is
one beat is five blocks, everything you can see can hurt you, and exactly one
hazard is hard to *see* rather than hard to do.

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
| `engine.ts` | clock, input, attempts, checkpoints, the sonar |

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

## The wave, twice

The full wave section is at beat 80 — forty seconds in, behind the hardest half
of the level, which meant the best-looking mode in the game was one almost
nobody was going to see. So there is now five beats of it at beat 38, about
eighteen seconds in, as a taster and as the transition into the ship.

Neither wave stretch gets any paint. A wave dies on contact with *anything*, so
a decoy inside its tube is indistinguishable from a wall, and a section you
cannot read is not a hard section, it is a coin flip. The green does the lying
there; the gears do the decorating.

## The move the level is built on

An unnecessary jump costs nothing — it lands one beat later, in time for the
next one — so a level made of things to jump over has only one instruction in
it. The interesting instruction is the other one: **do not jump.**

Real teeth at head height over clear floor, and a real sawblade at the same
height a few beats later, saying the same thing with the other shape. Run
straight through and live; jump and die on the ceiling. It is the hardest thing
to do in a game whose only verb is jump, and the level asks for it four times.

A cube at the apex of a jump has its top 3.6 blocks up; the teeth hang at 3 and
their girder sits at 4. So the girder is real solid geometry that nothing can
ever touch — honest without being in the way.

## The sonar

The reveal mechanic is a **sound**, not an eye. Three pings per attempt, `E` or
right-click or the button. A ping goes out and for 1.6 seconds what comes back
is the shape of the level: scenery inside an expanding ring drops away, every
hazard gets a bright outline, and the one spike drawn at 15% opacity comes all
the way in.

It started life as an "eye" that let you see in the dark, which was exactly the
wrong idea for a level about not being able to trust your eyes. As sound it is
both better thematically and better to use: the ping is two falling sine notes
0.75 of a beat apart — the one you send, and the one that comes back — and the
sweep on screen is two rings at the same spacing, so what you see is what you
just heard.

Nothing lethal is ever drawn below 6% opacity, so a ping is a shortcut through
the learning and never the only way through.

## The background is the music

The vertical bars behind the level are not decoration. `audio.ts` taps the
master bus with an `AnalyserNode`, and `render.ts` draws those bins — log-
bucketed, because linear bins put everything you can hear in the first eighth
of the display — as the backdrop. In a level whose one honest signal is a
sound, the background should be that sound.

When there is nothing real to show, the bars fall back to breathing on the beat
clock. That covers two cases that both matter: before the first user gesture
there is no audio context at all, and a muted player produces a live analyser
reading pure silence. Either way a dead flat graph would be worse than an
honest idle animation.

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

## Nothing is spawned. It is drawn.

There is **no random number generator in this game**, anywhere — and now
nothing that is drawn like a hazard is anything but one. Getting here took four
attempts at the same problem.

1. A scatter of randomly rotated, randomly scaled shapes. Read as confetti —
   nobody mistakes a spike tilted 37° for a hazard, so nothing was being
   deceived; the screen was just noisy.
2. A scatter of grid-aligned, correctly-sized shapes from a seeded PRNG.
   Better, and still debris: three towers in a row and then forty empty
   blocks, saying nothing. Reproducible is not the same as designed.
3. **Four bars of dressing, drawn by hand, tiled.** `BAR_STREET`,
   `BAR_SPIRES`, `BAR_LOW` and `BAR_SPARSE` in `level.ts` are eight beats of
   background each, written as a list of motifs at block offsets; read a column
   of the x numbers and you are reading the silhouette. Each movement picks
   which bars to tile. That is how levels in this genre are actually built — a
   designer draws a bar of background they like and reuses it.
4. **The bars became architecture only.** They used to contain painted spike
   rows, pixel-for-pixel identical to lethal ones. There is not a single
   painted spike left anywhere in the level.

Three rules hold it together:

- **Every hazard is real.** No painted spikes, no painted sawblades. The
  scenery layer may contain buildings and question marks and nothing else.
- **It stands on something.** Scenery rises from the floor; teeth hang from a
  ceiling that exists, or from a **girder** (`mount: true`) put there for the
  purpose. A spike in mid-air reads as a rendering bug.
- **Nothing floats but the sawblades**, because a sawblade hanging in mid-air
  is what a sawblade *is* — and now that they kill, floating is the whole
  point of them.

Four tests hold all of it: no painted spike or sawblade exists; nothing with a
hitbox lives in the scenery layer; nothing is neither standing on nor hanging
from anything except a sawblade; and no piece of scenery sits off the
half-block authoring grid, because a thing placed by a random number lands on
an arbitrary coordinate and a thing placed by a person lands on the grid they
were drawing on.

## Sawblades kill

They were decoration for most of this level's life, which was always slightly
dishonest: a spinning blade of teeth that cannot hurt you is a promise the game
does not keep. Every one is real now, placed by hand at a height chosen against
the jump arc, and `ispy.test.ts` flies the whole level to prove the placements
are survivable. Nothing lethal is left to a loop's arithmetic, let alone to
chance. The first one in the level hangs at 5.5 blocks where nothing can reach
it, so you get eight seconds to learn the shape before one is in your way.

## A base you could stand on

The ground used to be a two-pixel line with the picture stopping under it. It
is now three courses of masonry with offset joints, a lit lip, and the glow it
throws up into the level — and the camera floor sits 1.7 blocks below the level
floor so you can actually see it. The palettes' ground colours are nearly
black, so the face is mixed toward the section accent; otherwise a "solid base"
renders as the place the screen ends.

## Three ways to play

`DIFFICULTIES` in `engine.ts`. The interesting constraint is that this level is
welded to its music — one jump is one beat is five blocks — so the usual easy
mode of "slow the player down" would shorten every jump and stop the hazards
lining up with the beat.

So `rate` scales **the simulation and the tempo by the same factor**. Every arc
stays identical in space, every block stays where it was, and only the clock
changes. Easy is the same level, played more slowly.

| mode | rate | hitbox | pings | checkpoints | coins |
| --- | --- | --- | --- | --- | --- |
| Chill | 0.8× | none — nothing can touch you | ∞ | yes | no |
| Easy | 0.85× | 62% of the original's | 6 | yes | yes |
| Normal | 1× | the original's 18×18 | 3 | no | yes |

Chill is a sightseeing mode: hazards do not touch you, walls are not there, and
the wave stops dying on contact, so anyone can see the whole level and hear the
whole score. Two tests hold it, and they are the ones worth having — hold no
buttons for the entire level and you still arrive; lean on the button for the
entire level and you still arrive. A mode whose only promise is "you cannot
die" has exactly one thing it must not get wrong.

Coins are banked only by a run that could have gone wrong, so Chill and
practice do not count. Easy does.

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
is the sonar, and it is deliberate.

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

## Why there is a reveal at all

Three per attempt, `E` or right-click or the button in the corner.

It exists because the alternative is a level whose only teacher is death.

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
