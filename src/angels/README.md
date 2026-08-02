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
entities/
  jet.ts           the parametric airframe builder and its livery
  effects.ts       smoke oil, wingtip vapour, contrails, the vapour cone
play/
  fleet.ts         you, five wingmen, and the formation controller
  courses.ts       six ring courses along real routes
  game.ts          modes, scoring, radio, and twenty Seattle Easter eggs
audio/audio.ts     four-voice engine, airflow, one-shots — all synthesised
ui/                the HUD and everything on top of the canvas
```

Systems never import one another. They publish into `ctx.services` and any one
of them can fail at boot without taking the world down.

---

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
```

`?shot=1` skips the hangar screen, exposes the engine on `window.__angels`,
and drops the quality to `low` so the software rasteriser can keep up; `?q=`
overrides the tier. `engine.step(dt, render)` advances the simulation without
drawing, which is how the harness fast-forwards five hundred frames of
formation flying in under a second.

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
