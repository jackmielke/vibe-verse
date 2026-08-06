# Blue Angels — Seafair over Seattle

Route: `/blue-angels` (aliases `/angels`, `/seafair-show`).

A flight simulator over a real Seattle, in which **you are number 1** and the
other five jets fly your wing.

---

## The two things this world is about

**It has to be a flight simulator.** Real lift, real drag, real thrust lapse
with altitude, a wing that stops working if you ask too much of it, and seven
airframes that fly differently because their spec sheets differ — not because
someone typed different handling numbers.

**It has to be flyable with a thumb.** On a phone. In portrait.

Those pull in opposite directions, and the resolution is the one McDonnell
Douglas reached in 1978: put a fly-by-wire computer between the stick and the
control surfaces. Aft stick commands **G**; lateral stick commands a **roll
rate**; the rudder is coordinated for you unless you take it. That is how an
F/A-18 actually flies, and it happens to be exactly what a touchscreen needs —
a control that asks for an outcome rather than a surface position degrades
gracefully when the input is a fingertip.

Underneath the control law nothing is assisted. The FBW asks for 7 G; if the
wing cannot make 7 G at this speed and density you get buffet and a stall
warning instead. That is the lesson that makes a flight sim feel like flying,
and it survives all the way down to a phone.

---

## Layout

```
flight/          the simulator. No Three.js anywhere in here.
  atmosphere.ts    ISA, thrust lapse, indicated airspeed, contrail criterion
  aircraft.ts      the hangar: seven airframes, real numbers
  dynamics.ts      the flight model and the fly-by-wire control law
  dynamics.test.ts 18 assertions a pilot would recognise
engine/
  core.ts          renderer, fixed-step accumulator, event bus, teardown
  input.ts         keyboard + mouse + gamepad + the touch overlay
  camera.ts        chase / cockpit / wing / tower / cinematic
world/
  geo.ts           Seattle, in real lat/lon. The single source of truth.
  field.ts         the baked height field everything samples
  env.ts           shared lighting uniforms, scattering, tone mapping
  sky.ts           dome, two cloud decks, key + fill
  terrain.ts       the ground mesh, and the mountains outside the box
  water.ts         Puget Sound, Lake Washington, Lake Union, Green Lake
  city.ts          instanced fill + two dozen hand-built landmarks
  life.ts          hydroplanes, the spectator fleet, log booms, ferries
entities/
  jet.ts           the parametric airframe builder and its livery
  effects.ts       smoke oil, wingtip vapour, contrails, the vapour cone
hydro/
  boat.ts          the hydroplane. No Three.js in here either.
  boat.test.ts     14 assertions an unlimited driver would recognise
play/
  fleet.ts         you, five wingmen, and the formation controller
  hydro.ts         the race: the course, the laps, the rooster tail
  courses.ts       six ring courses along real routes
  game.ts          modes, scoring, radio, and twenty Seattle Easter eggs
audio/audio.ts     four-voice engine, airflow, one-shots — all synthesised
ui/                the HUD and everything on top of the canvas
```

Systems never import one another. They publish into `ctx.services` and any one
of them can fail at boot without taking the world down.

---

## You start pointed at the Space Needle, and it is solid

The default start puts the flight two and a half kilometres north-north-west of
the Space Needle at 1,500 feet, on a heading of 152° — which is the bearing to
the Needle and on over Columbia Center. Thirteen seconds later you are over the
saucer with the whole of downtown opening up in front of you. Every other start
is still there; this one is the default because the first ten seconds of a world
are the ones that decide whether anybody sees the eleventh.

The landmarks have collision hulls. One vertical cylinder each, from
`landmarkHull()` in `world/geo.ts`, deliberately coarse: a Space Needle modelled
to the metre would mean threading its three legs at 400 knots and calling it a
near miss, and nobody watching would agree with the game about what happened.
The eleven thousand *fill* buildings have no hulls at all, and that asymmetry is
the right one — fill has no identity, so passing through it reads as nothing
happening, while passing through the Space Needle reads as the game being
broken.

Player only. A wingman who clips a tower every time you take the flight down
Fifth Avenue is a lake full of dead teammates, which is why the formation
controller already cheats to stay out of the ground.

## Crashing

Three things had to be separated that all look like "hit the ground":

- **A landing** — wheels down, wings level, under six metres a second.
- **A firm arrival** — rattles the airframe and the camera via `impact`, and
  you fly on. This band exists on purpose. A crash system with no "ouch" short
  of "scrap" punishes every heavy landing with a cutscene.
- **A crash** — `state.crashed`: more than nine metres a second of sink, past
  about 40° of bank, more than 24° nose-up or nose-down, wheels up at any
  speed, or water, because nothing here floats.

The last of those hands off to `entities/blast.ts`, which is the one thing in
this world built to look *good* rather than to look *right*: a white flash, a
fireball that expands fast and decelerates through white → orange → soot, three
more fireballs behind it from different points along the wreckage, forty
tumbling shards on ballistic arcs, a shock ring on the deck and a smoke column
that outlives all of it. The camera cuts to a wreck cam two hundred metres back
and watches. After 3.6 seconds — or as soon as you press the button on the card
— you are back at whatever start point you chose.

Two things do more for the *weight* of it than any amount of fireball. The
engine drops to 28% speed for most of a second (`ctx.slowMotion`) — an impact at
four hundred knots is over in about as long as it takes to notice one started,
and stretching that out is why every game with a good crash has one. And the
camera shake is *held* for a second and a half rather than decaying in the usual
third of a second, so the frame is still being thrown around while the fireball
is climbing. `step()` is deliberately exempt from the time scale: the harnesses
drive time explicitly, and a hidden multiplier on their dt would make every
frame-counting check a function of whether something happened to be exploding.

Things that were wrong first:

**`OUTPUT_GLSL` declares `uniform float uExposure` itself.** Declaring it again
next to the include is a GLSL redefinition, a redefinition is a failed compile,
and a failed compile is a mesh that is `visible: true`, at the right position,
at the right scale, drawing absolutely nothing. All five shaders in the blast
did it, so the first working crash was a perfect card in front of an empty sky.

**`length(position)` on a sphere shell is 1.0 at every vertex.** It was meant to
fade the fireball from the edges in; what it actually did was make every
fragment equally translucent, and the explosion came out as a yellow glass
balloon. The number that turns a sphere into a fireball is how square-on the
surface is to the camera — the middle of the disc is looking down the deepest
column of burning fuel, so it is both the hottest and the most opaque.

**A parked jet was being trimmed to the stall angle.** `trimLevel` solves for
the angle of attack that gives level flight at the speed you ask for; at zero
knots that wants infinite lift coefficient, and the clamp handed back 85% of the
stall angle. A Super Hornet on the Boeing Field ramp spawned pointing thirty
degrees at the sky. It used to snap level over the next few frames and read as a
pop; once arriving nose-high became a crash, it detonated on the concrete.

**`pitchAttitude` is published at the bottom of `stepFlight`**, so the contact
test at the top was reading the previous step's value. Normally free; on the
first step after a respawn it is the *previous flight's* attitude, which is how
a jet parked on a runway came to be judged by the dive it was in when it hit the
lake thirty seconds earlier. The contact test reads the live orientation now.

## Four ways to fly it, and the default needs no explanation

The thing that made this world hard to fly is one detail that reads as a bug to
anybody who has not flown: **left does not turn left.** Left *rolls*. The
aeroplane then falls sideways out of the sky until you also pull, and somebody
who presses left, watches the nose drop and concludes the controls are broken is
not wrong about what they saw. The first keyboard scheme did exactly that.

So the default is **Arrow keys**, and in it left turns left. Up climbs. Let go
and it flies straight and level. The bank angle and the pull that a turn
actually needs are worked out for you, and so is the throttle.

It is not a separate control system. The arrow keys walk the same pursuit ring
the mouse moves in **Point & fly**, and `flyToAim` in `play/fleet.ts` turns that
ring into a bank and a pull for both. Which means "easy mode" gets the ring
drawn on the HUD for free, and the control explains itself: there is the thing
you are steering, and there is the velocity vector chasing it.

The other two are **Direct stick** (the cursor is the stick, neutral at the
middle of the screen) and **Keyboard** (A and D roll, W and S pull — the real
thing). All four are one click apart in the card, Options, or the pause menu.

### The pursuit law

Two numbers. The aim direction, resolved in the aircraft's body frame, gives how
far off it is to the right and how far above the canopy. `atan2` of the pair is
how far to roll to put the target overhead — where a wing wants it before it
pulls — and the vertical component alone is how hard to pull once you are there.

Four details separate "works" from "feels right", and all four came from
watching it misbehave:

**Measure the error from the velocity vector, not the nose.** The first version
drove the *nose* onto the ring, so with the ring centred it flew the nose to
where the camera was looking — which means unloading to zero G, because level
flight needs the nose a few degrees above the flight path and this was busy
removing exactly those few degrees. Let go and the jet sank at twenty-four
metres a second. Measuring from the velocity vector makes "ring centred" mean
"carry on as you are", and makes the dashed line the HUD draws between the two
literally the thing being closed.

**Weight the roll by how much error there is.** `atan2` answers "which way
round" without caring "by how much", so a two-degree pointing error earns a
ninety-degree roll command exactly as loudly as a real one does. Combine that
with a chase camera that lags in a turn and the jet hunts, rolling hard to fix
an error the roll itself created.

**Floor the `atan2` denominator.** At zero it snaps to ±90° for any lateral
error at all when the target is a hair below the nose — which, because the chase
camera looks slightly down at its own aeroplane, is always.

**Cap the bank in easy mode.** The law will happily roll to eighty-seven degrees
because that genuinely is the fastest way to get where it was pointed, and
"turn left" from a beginner does not mean a knife-edge. Fifty-five degrees.

## Space is the way out of trouble

The other half of the answer. Press it — or the amber `LEVEL` button, which is
in the corner on a desktop and on the touch overlay on a phone — and the jet
rolls upright and flies back to the horizon, climbing if it is low. Any real
stick input cancels it instantly, because the point is to hand the aeroplane
back rather than to fly it for you.

Two things it gets right that the obvious implementation does not:

**It flies the flight path, not the attitude.** Levelling the nose of a jet
descending at ninety metres a second leaves it descending at ninety metres a
second with the nose level, because the wing is at a positive angle of attack
and the aeroplane goes where the air says. Driving *gamma* to zero is the
difference between looking recovered and being recovered.

**It measures bank off the body axes, not off `state.bank`.** That number comes
out of a YXZ Euler decomposition, which is fine for an instrument and
degenerate at exactly inverted — where it reports a bank of *zero*, in the one
attitude the recovery most needs to know better. Two dot products have no such
opinion.

And it ends when the jet is level, not when a stopwatch says so. A fixed
three-second recovery gave a steep dive three seconds of pull and then handed
the aeroplane back still pointed at the ground, which is the exact outcome the
control exists to prevent. There is still a cap, so a jet with no speed and no
wing does not fly itself for ever.

Airbrake moved from `Space` to `B`, where it merged with the wheel brakes —
one control that is the airbrake in the air and the brakes on the ground, which
is what the phone's BRK button always was. They are never both useful at once,
and it freed the biggest key on the keyboard for the one that matters most.

## The other half of Seafair

Seafair is a boat race that grew an air show, and the boats have been out there
running the real course since the first version of this world. **Race a
hydroplane** in the hangar puts you in the seventh one.

`hydro/boat.ts` is the model, and it has no Three.js in it for the same reason
the flight model does not — it is arithmetic and it is tested as arithmetic,
fourteen assertions covering the four things that make a hydroplane a
hydroplane rather than a boat with a big engine:

- **A drag cliff.** An unlimited rides on two sponson tips and a propeller with
  about a square metre of hull in the water. Below planing speed it is dragging
  a hull through a lake; above it the drag more than halves. Getting on the
  plane is an event you can feel, and it is why the first ten seconds of a start
  are nothing like the rest of a lap.
- **It steers on the water, not on the hull.** The rudder works in the
  propeller's wash, so authority scales with how much water is going past —
  nothing at all when stopped, best in the middle of the range, and falling away
  at the top end where a real unlimited needs most of the lake to change
  direction.
- **It leans *out* of the corner.** The outboard sponson carries the load. Roll
  it inward and it reads as a motorcycle, which is exactly wrong.
- **It can blow over.** The hull is a wing in ground effect: get the nose up at
  speed, over somebody else's rooster tail, and the air underneath wins and the
  boat goes over backwards. It is the signature accident of the class and the
  reason passing is frightening. The HUD warns you as the lift builds, because
  an accident you can hear coming and back off from is racing, and one that
  arrives out of nowhere is a dice roll.

The lift coefficient is set so that flat out in clean air sits at about 0.6 of
the way to a blowover — uncomfortable, visible on the warning, survivable. Rough
water is what takes it over the top, which puts the danger where the racing is
instead of making the throttle itself the enemy.

Two pieces of reuse do most of the work. The race does not spawn its own field:
`world/life.ts` was already driving six boats round the right oval at the right
speed, so it publishes their course progress and the race scores against them —
one field of hydroplanes on a lake is enough. And a blowover emits
`angels:crash`, which means the fireball, the camera shake, the slow motion, the
boom and the white flash all arrive without `play/hydro.ts` knowing any of them
exist. That is what the event bus is for, and it is why a boat going over
backwards looked as expensive as a jet hitting the Space Needle on the first
attempt.

Scoring is by progress *since the flag*, not by absolute position round the
oval — the AI boats have been circulating since the world booted, so absolute
position would mean starting sixth of seven for no reason anybody could see.

## Seafair is the point## The other half of Seafair

Seafair is a boat race that grew an air show, and the boats have been out there
running the real course since the first version of this world. **Race a
hydroplane** in the hangar puts you in the seventh one.

`hydro/boat.ts` is the model, and it has no Three.js in it for the same reason
the flight model does not — it is arithmetic and it is tested as arithmetic,
fourteen assertions covering the four things that make a hydroplane a
hydroplane rather than a boat with a big engine:

- **A drag cliff.** An unlimited rides on two sponson tips and a propeller with
  about a square metre of hull in the water. Below planing speed it is dragging
  a hull through a lake; above it the drag more than halves. Getting on the
  plane is an event you can feel, and it is why the first ten seconds of a start
  are nothing like the rest of a lap.
- **It steers on the water, not on the hull.** The rudder works in the
  propeller's wash, so authority scales with how much water is going past —
  nothing at all when stopped, best in the middle of the range, and falling away
  at the top end where a real unlimited needs most of the lake to change
  direction.
- **It leans *out* of the corner.** The outboard sponson carries the load. Roll
  it inward and it reads as a motorcycle, which is exactly wrong.
- **It can blow over.** The hull is a wing in ground effect: get the nose up at
  speed, over somebody else's rooster tail, and the air underneath wins and the
  boat goes over backwards. It is the signature accident of the class and the
  reason passing is frightening. The HUD warns you as the lift builds, because
  an accident you can hear coming and back off from is racing, and one that
  arrives out of nowhere is a dice roll.

The lift coefficient is set so that flat out in clean air sits at about 0.6 of
the way to a blowover — uncomfortable, visible on the warning, survivable. Rough
water is what takes it over the top, which puts the danger where the racing is
instead of making the throttle itself the enemy.

Two pieces of reuse do most of the work. The race does not spawn its own field:
`world/life.ts` was already driving six boats round the right oval at the right
speed, so it publishes their course progress and the race scores against them —
one field of hydroplanes on a lake is enough. And a blowover emits
`angels:crash`, which means the fireball, the camera shake, the slow motion, the
boom and the white flash all arrive without `play/hydro.ts` knowing any of them
exist. That is what the event bus is for, and it is why a boat going over
backwards looked as expensive as a jet hitting the Space Needle on the first
attempt.

Scoring is by progress *since the flag*, not by absolute position round the
oval — the AI boats have been circulating since the world booted, so absolute
position would mean starting sixth of seven for no reason anybody could see.

## Seafair is the point

The air show was added to a boat race, not the other way round, so the boat
race is in here: six unlimited hydroplanes running the real course off Stan
Sayres at 150 mph with thirty-metre rooster tails, the log booms that bound it,
and several hundred spectator boats rafted up outside them. That fleet is what
makes a low pass down the show line feel like it is *for* somebody, and it is
also the only thing that gives the water a scale — at 1,500 feet over open
water you genuinely cannot tell how fast you are going until something small
goes past underneath.

The fleet is placed by rejection sampling against the terrain's own water mask,
because a fixed offset band from the course centreline puts a third of it in
Genesee Park, and a cabin cruiser parked in a park is the sort of detail that
becomes the only thing anyone sees.

## You can start cold on the runway

"Boeing Field" in the hangar puts you stopped on 14R with the gear down and the
throttle at idle, and nothing happens until you push it up. Full power, hold it
straight, rotate somewhere past 130 knots, gear up: about fourteen seconds to
airborne in a Super Hornet, which is what it should be. Almost no arcade flight
game lets you have the first thirty seconds of a real flight, and they are some
of the best thirty seconds in aviation.

## Things that took more than one try

**Sign errors are invisible until they are not.** Two of them shipped in the
first draft of `dynamics.ts`: the wings-level assist banked *into* the error
instead of out of it, and the sideslip loop was positive feedback. The second
one looked perfectly stable for thirty-eight seconds and then departed. Both
were found by a test that flies for a minute and asserts the heading has not
moved — which is why that test exists.

**Three does not tone-map a raw `ShaderMaterial`.** Its ACES curve and its sRGB
encode are shader *chunks*, spliced into the materials Three wrote. Every
material here is custom, so all of them were writing scene-linear radiance
straight into an sRGB framebuffer: no highlight roll-off, no gamma, and a
picture that came out dark no matter what the lights did. `OUTPUT_GLSL` in
`env.ts` does the job by hand now, and `renderer.toneMapping` is off precisely
because it would only reach the two built-in materials in the whole world.

**A camera-locked sky dome must be synced in `onBeforeRender`.** Updating it in
`update()` leaves it one frame behind the camera, and one frame at 400 knots is
six metres — enough to put the camera outside a radius-1 sphere and turn the
sky black. It rendered fine standing still, which is the worst kind of bug.

**Water seen from a jet must be stochastic.** The textbook cheap-water recipe —
four crossed cosine wave trains — interferes into a stationary herringbone that
covers the whole lake. Real water from 1,500 feet is irregular glitter with no
repeating structure anywhere in it, so the normal is carried by noise and the
sines only supply the drift.

**Formation offsets belong in the leader's body frame.** When you roll, the
whole Diamond sweeps around your roll axis as one rigid object, because that is
literally what the wingmen are asked for. A world-frame implementation of the
same manoeuvre looks wrong in a way that is hard to name and impossible to
unsee. The controller is PD, not P: proportional alone is an oscillator, and a
formation that oscillates is a flock of pigeons.

---

## The geography is real

`world/geo.ts` is traced from actual coordinates: the lake outlines, Mercer
Island, both floating bridges with their real spans, the Ship Canal and the
Montlake Cut, twenty-six landmarks at their real addresses and real heights,
three airports with their real runway thresholds, and Mount Rainier 94 km away
on a bearing of 153°.

That accuracy is not pedantry — it is why the world reads as Seattle from 3,000
feet. A skyline with the right buildings in the wrong places looks like a
generic city. The Needle north-west of downtown, Columbia Center as the one
obviously-tallest tower, the two floating bridges lying parallel across the
lake with Mercer Island between them, Rainier over your right shoulder on the
southbound run: get those five right and the other eleven thousand buildings
can be procedural.

Datums matter too. Puget Sound is at 0 m and the lakes are at +4.9 m, which is
what the locks at Ballard are for and why the Montlake Cut has current in it.

---

## Harnesses

```bash
# Review frames from the game's own camera rigs.
node scripts/angels-shot.mjs shots/g.png --all --quality high

# One pose, hand-picked, at card size.
node scripts/angels-shot.mjs src/assets/worlds/blue-angels.jpg --pose card \
  --quality high --size 1600x900 --jpeg

# Prove the touch controls work in both orientations. Exits non-zero if a
# control lands outside the viewport or the stick fails to reach the jet.
node scripts/angels-phone.mjs shots

# The gameplay claims a screenshot cannot show: hoops register, the Easter eggs
# fire on the right geography, the Diamond converges, the demo caller advances,
# a cold jet flies off 14R, the Space Needle and the lake are both fatal while a
# runway is not, the wreck hands the jet back, and dispose() releases the
# context.
node scripts/angels-check.mjs

# The desktop controls, end to end through React: the card opens once, the ring
# actually steers the jet and settles rather than hunting, Space saves a dive
# that would otherwise kill you, and W and S are the throttle.
node scripts/angels-desktop.mjs
```

`?shot=1` skips the hangar screen, exposes the engine on `window.__angels`,
and drops the quality to `low` so the software rasteriser can keep up; `?q=`
overrides the tier. A dev build exposes the engine too, which is what lets
`angels-desktop.mjs` start on the real page with its menus intact — the path
it is testing runs from a DOM event through React to the flight model, so
skipping the menus would skip the thing under test. `engine.step(dt, render)`
advances the simulation without drawing, which is how the harness
fast-forwards five hundred frames of formation flying in under a second.

Anything that measures the aeroplane must drive `step()` rather than wait on
the clock. SwiftShader runs this world at about three frames a second, so a
check that sleeps for half a second and expects the jet to have banked is a
check that passes on a laptop and fails on the build machine.

Both harnesses refuse to write a blank frame. On SwiftShader a lost context
produces a perfectly plausible black JPEG, and a black JPEG committed as card
art is worse than no card art at all.

---

## Adding an aircraft

Add an entry to `HANGAR` in `flight/aircraft.ts`. The mesh builder reads
`shape` and the dimensions; the flight model reads everything else. Nothing
else needs to change — the hangar screen, the fleet, the effects and the audio
all enumerate the roster. Keep the numbers real: the whole point of the roster
is that a Skyhawk rolls four times faster than a Phantom because it *did*.
