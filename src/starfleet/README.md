# STRANGE NEW WORLDS

Twelve real Star Trek systems, a warp drive that uses the real warp scale, and
somebody standing at the bottom of every transporter beam who will talk back.
Route: `/strange-new-worlds` (also `/snw`, `/starfleet`).

## The one idea

**`/trek` is the half of Star Trek where you shoot. This is the other half.**

There is no combat in here at all, and that is a decision rather than an
omission — the vibeverse already has six worlds that shoot, and it has one
starship bridge sim next door. What it did not have was the part of the show
that is actually the show: you make orbit around somewhere nobody has been, you
run the sensors, and then you go down and *ask it a question*.

So the loop is seven verbs, and every one of them is a key as well as a button:

    chart → warp → orbit → scan → hail → beam down → walk → talk → beam up

## Direct inspiration

The shape is lifted from `src/longsilence` — the vendored Long Silence that is
`/vibeverse`. A star chart of hand-authored systems; one procedural planet per
system, tuned to look like the place from orbit before you commit to going;
a fold between them that is the best-looking thing in the game; and a surface
you can stand on at the end of it. That structure is upstream's and it is a
good one.

What is different is what is at the bottom of the descent. In the Long Silence
the payoff is a *route* — touchdown hands you off to another world in the hub.
Here the payoff is a *person*.

## What is in here

| directory | what it owns |
| --- | --- |
| `galaxy/` | the chart: twelve systems, real astronomy, authored planets |
| `crew/` | sixteen people — three officers and thirteen strangers — and the channel to them |
| `space/` | the planet shader, the star, the starfield, the ship, warp |
| `surface/` | terrain, the architecture kits, the bodies, walking, weather |
| `ui/` | LCARS, and it is the controls rather than a skin over them |
| `game.ts` | the state machine, the clock, and the only module that knows both scenes exist |

Nothing imports anything sideways. The space scene has never heard of the
surface, the surface has never heard of the warp drive, and the UI holds a
reference to `game` and to nothing else — everything they need to say to each
other goes over the bus in `types.ts`.

## The chart is true where it can be

Where a star is real, its numbers are real. 40 Eridani A is 16.3 light years
out and really is a K1 dwarf; Procyon is 11.46 and really is an F5 subgiant
with a white dwarf companion; Wolf 359 is 7.86 and really is an M6 red dwarf
too dim to have been catalogued until 1918. The chart projects actual stellar
positions for those, and Memory-Alpha's stated distances for the invented ones,
which is why Vulcan is next door and Qo'noS is ninety light years away and the
crossing between them is a different kind of decision.

The warp scale is the TNG one — v = w^(10/3)·c, warp 9 at 1516c — and the
travel time in the log is what that arithmetic actually produces. Ninety light
years at warp 8 is thirty-two days, the stardate advances by thirty-two days,
and the animation takes six seconds. Reporting the true figure while showing a
compressed one is the compromise every episode of this show has ever made.

And where the show gave a fact, the show wins. Vulcan's gravity is 1.4 g and
you feel it in the jump; Ferenginar's language has 178 words for rain; Talos IV
carries the only General Order in Starfleet that still ends in the death
penalty, and `hazard` on Ceti Alpha V refuses the transport. A scan that tells
you something true about a world you have known since you were nine is the
whole appeal of the exercise.

## The people

Sixteen personas in `crew/characters.ts`, and each one carries three separate
things on purpose.

**`look`** is what the surface builds a body out of. No rig, no downloaded
clip: eleven primitives, six rotations a frame off a phase, and two species
tells that read at ten metres. Antennae mean Andorian, a forehead crest means
Klingon, an earring on the right means Bajoran, a spot line means Trill,
pointed ears mean Vulcan or Romulan and the robe separates those two.

**`persona`** is what the model is told, and it is *specific* — not "you are a
Klingon" but where this person is standing, what they want out of the
conversation, and the one subject they will not discuss. The rule that holds
all sixteen together: **nobody here is an assistant.** They have their own
business, they were doing it before you arrived, and several of them would
prefer you left. Senator Vraal will not confirm a Romulan capability. Gul Terec
never quite answers. The Keeper of Talos IV comments on what you are *feeling*
rather than on what you said. A Romulan senator who cheerfully helps you is not
a Romulan senator.

**`bank`** is what answers when the network does not — and it is not a fallback
in the apologetic sense. A character who says "I'm having trouble connecting"
has broken the world far more thoroughly than one who says something slightly
generic, so **there is no error state**: no key, no function, no network, a
plane, a corporate proxy — the character keeps talking, in the same voice,
matched on keywords, and the seam is invisible from the outside. The small
light on the comm panel is the only thing that knows.

The live brain is `supabase/functions/trek-comms`, one function for all sixteen
because the persona travels with the request. Adding a seventeenth character is
a client-side edit and no redeploy.

## Five things that were got wrong once and are now load-bearing

- **Standard orbit is a composition constant, not a physical one.** At 1.9
  planetary radii the limb sits 58° off the along-track axis, which is outside
  a 58° frustum — so the HUD read STANDARD ORBIT and the screen showed empty
  space with a scratch of ring in the corner. 1.33 R, camera nine behind and
  eight above, look-at dropped 23 toward the planet. Those four numbers are one
  shot; move any of them alone and you lose the ship off the top or the world
  off the bottom.
- **The orbit basis was left-handed.** `makeBasis` wants right, up, *backward*,
  and the first version crossed forward with the downward radial — which flew
  the ship inverted, and since the chase camera takes its `up` from the same
  quaternion it put the planet at the top of every frame and the look-down tilt
  pushed it further off screen rather than into it.
- **The key light cannot be at azimuth 180.** The transporter always puts the
  away team down facing −Z. A key behind the thing you are looking at renders
  every person, pillar and statue on the world as a black cut-out, which is
  what all eleven of them did on the first pass. 20-60° or 300-340°: a
  three-quarter key over the away team's shoulder.
- **Stone must be several stops lighter than the ground it stands on.** Seleya
  shipped with a 0x9c4f2b sandstone on a 0xa1522c mountain — the same colour —
  and nine rules of architecture rendered completely invisible. Hue can match;
  value cannot.
- **Pointer lock swallows the entire interface.** A locked pointer routes every
  click to the canvas, so engaging it on the title card made the whole LCARS
  rail unclickable. Lock is opt-in by clicking the viewport, every panel
  releases it, and looking around without it is a drag with the button held.

## Playing it headless

```
node tools/snw-drive.mjs                      # the whole loop, with screenshots
node tools/snw-drive.mjs shots/ --systems all # every system, one frame each
```

A build proves nothing about whether the planet shader compiles, whether the
transporter puts the away team inside a mountain, or whether the person you
came to meet is standing behind you. This drives the real route in a real
browser through chart → warp → orbit → scan → beam → walk → talk → beam up,
writes a frame at every stage, and reports console errors and the transcript it
got back. It found all five of the bugs above.

Note that the reply it prints will come from the local bank rather than the
model unless the machine can reach Supabase — which is the point of the local
bank, and also a useful thing to be testing.
