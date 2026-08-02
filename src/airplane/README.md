# AIRPLANE! — Trans American Flight 209

Route: `/airplane` (aliases `/flight-209`, `/209`).

A Boeing 707 out of Los Angeles, a thunderstorm over Chicago, and 187 people
behind you. The captain, the first officer and the flight engineer all had the
fish. You did not, and you are in the left seat.

---

## The two things this world is about

**It has to be a real aeroplane.** Real lift, real drag, real thrust lapse with
altitude, engines that take eight seconds to spool, a wing that stops working
if you ask too much of it, and an ILS that is an *angular* beam and therefore
gets less forgiving exactly as the ground gets closer. Every number in
`flight/airframe.ts` is a 707-320B's real number, and the aeroplane behaves the
way it does because of them and not because somebody typed a handling
constant.

**It has to be funny while you are flying it.** Not between flying it. The
comedy and the difficulty are the same system: a crisis arrives in the cabin,
it has three answers and fifteen seconds, and every second you spend choosing
is a second you are not looking at the attitude indicator. Nothing behind you
can crash the aeroplane. What it can do is take your eyes off the panel at the
exact moment the panel needed them.

Those pull in the same direction, which is the lucky part. The film is about a
man who cannot cope being the only person who can, and that is also what a
divided-attention mechanic feels like from the inside.

---

## Layout

```
flight/          the simulator. No Three.js anywhere except the vector maths.
  atmosphere.ts    ISA, thrust lapse, indicated airspeed
  airframe.ts      the 707-320B, as a spec sheet
  dynamics.ts      six-degree-of-freedom flight model, 120 Hz
  autopilot.ts     Otto. Cascaded loops, gains scaled by how inflated he is
  nav.ts           Chicago, runway 09, the ILS, the PAPI
  dynamics.test.ts 47 assertions a pilot would recognise
engine/
  core.ts          renderer, two scenes, two cameras, fixed-step accumulator
  input.ts         keyboard + mouse + gamepad + the touch overlay
  camera.ts        cockpit / chase / wing / cabin / tower
world/
  env.ts           shared lighting uniforms, tone mapping, the lightning
  sky.ts           one dome, three regimes: under, inside and on top of it
  ground.ts        Chicago as a light field, and the 1980 skyline
  airport.ts       runway 09 and its two thousand lights
  lights.ts        every point light in the world
  weather.ts       rain, and how rain looks from something doing 140 knots
  surface.ts       the one lit material every solid object uses
cockpit/
  deck.ts          the flight deck, in the second render pass
  gauges.ts        eleven working instruments
entities/airliner.ts  the 707, from outside
play/
  aircraft.ts      who is flying: you, Otto, or nobody
  cabin.ts         the crisis deck
  script.ts        the dialogue engine and everything anyone says
  game.ts          phases, nerve, scoring
audio/audio.ts     four detuned engines, airflow, rain, thunder — all synthesised
ui/                the menu, the subtitles, the cabin panel, the results
```

Systems never import one another. They publish into `ctx.services` and any one
of them can fail at boot without taking the flight down.

---

## Things that took more than one try

**The heading indicator was mirrored, and nothing looked wrong.** `atan2(east,
north)` *is* a compass heading; running it back through the Three.js
yaw-conversion helper reflects it about north. The aeroplane flew perfectly,
the horizon was level, and every control law that read a heading — the
autopilot, the localizer tracker, the tower's instructions — confidently
steered the wrong way. Found by a test that flies straight for a minute and
asserts the heading has not changed.

**Otto's sideslip loop was positive feedback.** Beta is positive when the
aeroplane is moving towards its right wing, so zeroing it needs *right* rudder.
With the sign inverted the rudder drove the nose further from the relative
wind, and because a swept wing rolls away from sideslip, the aeroplane then
rolled the *opposite* way to the aileron and won. Perfectly stable in level
flight; departed the first time Otto was asked to turn.

**The descent rate on an ILS comes from groundspeed, not airspeed.** Following
a 3° path is geometry between the aeroplane and the runway; the air it is
flying through has nothing to do with it. Using true airspeed asks for eighty
feet a minute too much into tonight's headwind — invisible for the first
minute, and four hundred metres short of the threshold by the last one. This is
why the descent-rate table on every approach plate is indexed by groundspeed.

**A tracker with no integral cannot sit on a line in a crosswind.** Holding a
crab angle *requires* a non-zero output, and the only way a proportional term
produces one is to keep a standing error. On runway 09 that error worked out at
sixty metres — most of a runway width. Adding an integral fixed it; failing to
cap the integral's authority then S-turned the last two kilometres by a hundred
metres either side while it unwound.

**Nerve could only ratchet down.** The first version drained the meter whenever
stress was above a threshold and refilled it below. In a thunderstorm on an ILS
approach the stress is never zero, so a well-flown approach still emptied the
meter twelve times. It now settles *towards* a level set by the stress, so
sustained moderate pressure holds you at two thirds and only genuinely bad
flying reaches the floor.

**Additive blending after tone mapping does not roll off.** Each rain streak
tone-mapped its own contribution and the blend then summed display-referred
values — so the ACES curve that was supposed to protect the highlights ran
*before* the thing that overflowed them, and twenty overlapping streaks went to
white however dim each one was. Point lights want additive; anything there are
thousands of does not.

**A raw `ShaderMaterial` does not declare its own uniforms.** Three does that
for the materials it wrote. Hand it a uniform object for a custom shader and it
will upload every value in it to a program that declared none of them — and the
compile error names an "undeclared identifier" that is sitting right there in
the uniforms you passed. `declareUniforms()` in `world/env.ts` infers the GLSL
types from the values.

**The glareshield was at eye level.** Twenty centimetres of difference between
"looks right in a photograph taken from behind the seats" and "you can see the
instrument panel". The first flight deck here hid the entire panel *and* the
bottom half of the windshield behind a slab of coaming.

**Lightning that whites out the frame is indistinguishable from a broken
shader.** It is also what lightning does to a camera, which is why every
coefficient was set that way to begin with. The player is trying to keep a
runway in sight; a saturated frame carries no information. They peak around 0.8
in sRGB now — clearly the brightest thing that ever happens, and still a
picture.

---

## The two render passes

This world sits a yoke forty centimetres from the lens and a runway twelve
kilometres down the approach in the same frame. One camera would need a
near:far ratio around 1:400000, and depth precision falls off with the
reciprocal of distance, so the far half of that range collapses into a handful
of representable values and Chicago z-fights with the clouds.

So the frame is drawn twice, the way flight simulators do it: the world with
`camera` (near 1 m, far 60 km), then `clearDepth()`, then the flight deck with
`cockpitCamera` (near 3 cm, far 30 m), both sharing one position and
orientation. Each pass gets the whole depth buffer, and the cockpit is always
in front because it is drawn second — which is also physically true, since you
cannot see the world through the back of the instrument panel.

---

## Why the panel is laid out exactly like a 707's

The classic "basic T" — attitude in the middle, airspeed left, altimeter right,
heading below — exists because the scan between them is a short one, and the
whole last minute of this game is that scan. Rearranging it to look better on
a phone would make the game harder in a way that has nothing to do with flying.

The instruments are built three ways and never a fourth: **faces are drawn once**
onto canvases at boot and never touched again (redrawing this panel every frame
is 2 MB of texture upload per frame); **needles are geometry**, so they cost
nothing and stay sharp; and **anything that is not a needle is a shader** — the
attitude indicator is a gimballed sphere seen through a window, which no amount
of texture rotation gets right, so it is drawn procedurally from pitch and bank
and is correct at every attitude including upside down.

---

## Harnesses

```bash
# Review frames from the game's own camera rigs. Refuses to write a blank one.
node scripts/airplane-shot.mjs shots/g.png --all --size 1280x720

# The card, at card size.
node scripts/airplane-shot.mjs src/assets/worlds/airplane.jpg --pose card \
  --size 1600x900 --jpeg

# Play the whole thing headless: fly the ILS, flare, brake, read the score.
node scripts/airplane-fly.mjs
node scripts/airplane-fly.mjs --full
```

`?shot=1` skips the menu, exposes the engine on `window.__flight209`, and drops
the quality to `low` so the software rasteriser can keep up; `?q=` overrides
the tier. `engine.step(dt, render)` advances the simulation without drawing,
which is how `airplane-fly` flies a twelve-minute flight in ten seconds.

The screenshot harness **freezes the lightning** before it shoots. Strikes
arrive on a Poisson process several times a minute, so without that the same
pose photographs completely differently from one run to the next and about one
frame in six comes out as a white rectangle. Note that zeroing the uniform is
not enough — the sky system rewrites it from its own decay curve on the very
next step, so the strike generator has to be stubbed out and the live flash
allowed to decay first.

---

## Adding a cabin crisis

Add an entry to `CRISES` in `play/cabin.ts`. It needs a prompt, two or three
choices, and a timeout. Each choice carries a nerve delta, a passenger-calm
delta, the lines it produces, and optionally an `upset` — 187 people all moving
at once is worth several tonnes of centre-of-gravity shift and the aeroplane
notices.

The rule the deck is written to: **the wrong answer is funnier than the right
one, and never fatal.** Players should want to find out what happens if you let
the queue form behind the hysterical woman, and the game should charge them a
hundred feet of altitude for the privilege rather than the flight.
