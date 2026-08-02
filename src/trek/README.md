# THE FINAL FRONTIER

A Constitution-class starship, her bridge, and five episodes. Route: `/trek`.

## The one idea

**The main viewscreen is a live render of the space the ship is actually in.**

Everything else in this world exists to serve that. There are two scenes —
`space` holds the starfield, the hulls and everything that shoots; `bridge`
holds a circular room with six people in it — and every frame renders the first
one into an offscreen target, hands that target to the viewscreen's material,
and then renders the room. Four lines in `engine/core.ts`, and it is the whole
world:

```ts
renderer.setRenderTarget(screen.target);
renderer.render(space, viewCam);
renderer.setRenderTarget(null);
renderer.render(bridge, eyeCam);
```

The consequence is that nothing on that screen is a cutscene. When you order a
turn, Sulu answers and the stars swing because the ship turned. When you fire,
the beam on the screen is the beam that is doing the damage. When a Klingon
cruiser breaks off, it breaks off out of frame and you have to find it again.
A pre-rendered viewscreen would have been a tenth of the work and would have
been a poster.

Press `TAB` and the same camera draws straight to the canvas instead, and the
room is skipped. Same simulation, same frame — you have just left the room.

## What is in here

| directory | what it owns |
| --- | --- |
| `engine/` | renderer, the two scenes, the clock, input, the space camera |
| `bridge/` | the set: the room, the consoles, the crew, the viewscreen |
| `ships/` | every hull, built from primitives at published dimensions |
| `world/` | starfield, star, planets, the nebula, the rocks |
| `play/` | the combat model, ordnance, the crew's dialogue, the campaign |
| `audio/` | every sound, synthesised — nothing is downloaded |
| `ui/` | the DOM overlay: status, captions, title cards |

Systems never import one another. They publish into `ctx.services` and read
what they need from there, which is what lets the bridge be rebuilt without
touching combat, and lets any one of them fail at boot without taking the
episode down.

## Five decisions worth knowing about

**Ships are slow and turn badly.** 340 m/s, about fourteen degrees a second.
You cannot dogfight a starship. You commit to a pass and then live with it for
the ten seconds it takes to come round again — and every dramatic beat in a
Star Trek battle happens inside those ten seconds.

**Shields are four numbers.** Fore, aft, port, starboard: the four the show
names out loud. One shield bar is a health bar; four make *which way you are
pointing* the central tactical question, which is the question that crew is
always arguing about.

**Damage is reported, not displayed.** A hit that reaches the hull picks a
system at random and breaks it, and an officer tells you which one. Losing the
sensors is much worse than losing eight percent of a bar, and it is worse in a
way you feel rather than read.

**Red alert is the only thing that raises the shields.** A captain who forgets
to call it fights the first pass naked. That is the correct penalty and it is
the reason `Y` is the most important key on the board.

**One voice at a time, and nothing repeats inside its cooldown.** Without the
six-second floor on shield reports, sustained fire produces "shields at forty-one
percent, shields at forty percent, shields at thirty-nine percent" and the
illusion is over for the rest of the session. See `play/crew.ts`.

## The episodes

Each one is built around a mechanic no other episode has.

1. **The Kobayashi Maru** — the tutorial, and a no-win scenario. It teaches the
   controls while you lose, so the tutorial has stakes and no consequences at
   once. Losing it is the pass condition. Winning it says so.
2. **Balance of Terror** — the enemy is invisible and must decloak to fire. The
   entire episode is the four seconds it is visible.
3. **Errand of Mercy** — an escort. You are not trying to win a fight, you are
   trying to keep something else alive for ninety seconds.
4. **The Doomsday Machine** — a boss with an armoured hull and one open mouth.
   Phasers do nothing. Read the tell, put a torpedo down its throat while it is
   charging.
5. **The Mutara Nebula** — no shields, no sensors, and an opponent who fights in
   two dimensions. Climb.

## Why every sound is synthesised

The actual effects are somebody's property, and a world that shipped them would
be a world that had to be taken down. What is *not* anybody's property is the
physics: the bridge hum is a low drone with a fifth in it and a slow beat
between two detuned oscillators; the red alert is a sawtooth swept up hard and
cut off; a phaser is a buzzing tone ring-modulated at about thirty hertz; the
transporter is a cluster of sines glissing in opposite directions through
filtered noise. Build those from oscillators and the ear files the result under
"that show" without a waveform ever having been copied.

The most valuable eight lines in `audio/audio.ts` are the least dramatic:
`chatter`, which fires a soft blip from an unattended console every couple of
seconds. Take it away and the room dies.

Crew voices go through the browser's own speech synthesiser, with per-officer
pitch and rate so they are at least distinguishable. Every line is also
captioned, because that synthesiser is not reliable enough to be the only
channel — and it can be switched off entirely from the `VOX` button.

## Things that were got wrong once and are now load-bearing

- **The viewscreen stack is ordered by depth, and the camera is at +Z.** More
  negative is *further away*. The black recess goes behind the screen and the
  bronze bezel in front of it; reversed, the recess covers the picture and the
  world renders a bridge with a blank wall where its whole idea should be.
- **The perimeter crew stand inside the ring with their backs to the captain.**
  Facing them inward turns the senior staff into a briefing circle, which is
  not a thing that happens on that bridge.
- **Pooled beams have to be fully re-armed.** The planet killer's antiproton
  beam parks a fixed endpoint and a white colour on whichever pooled slot it
  borrowed; a phaser that inherits either fires at a point in space the target
  left ten seconds ago.
- **Lights are not pooled per-projectile.** three.js compiles a material
  variant per light count, so twelve torpedo lights blinking on and off means a
  shader recompile every few frames — which lands as a stutter at exactly the
  moment the battle gets busy. Three permanent explosion lights, and torpedoes
  are additive sprites.
- **No logarithmic depth buffer**, despite a 289 m ship and a planet in the same
  frame. Nothing lives in the middle distance, so a plain buffer covers both
  bands — and every hand-written shader in here would otherwise have needed the
  log-depth chunks threaded through it. See `NEAR_PLANE` in `types.ts`.

## Playing it headless

```
node scripts/trek-check.mjs            # all five episodes
node scripts/trek-check.mjs --only 3   # just The Doomsday Machine
```

A screenshot proves the world *draws*. It proves nothing about whether the
torpedoes hit, whether the Romulan ever decloaks, or whether episode four is
winnable at all — and those are the failures that stay invisible until someone
sits down to play and gets stuck. So this flies a deliberately stupid autopilot
(turn toward the target, hold the trigger, fire a torpedo whenever the tube is
loaded) through every episode with rendering off, and reports the outcome and
the damage traded. The whole campaign runs in about a minute.

It has already earned its keep four times over. It found that the campaign's
first draft:

- **never reached episode one**, because the harness set `game.mission`, which
  is a mirror of a private counter and moves nothing. Hence `goto()`.
- **shipped a winnable no-win scenario** — the Kobayashi Maru beaten on 90%
  hull, which makes the punchline land exactly wrong. Hence the second wave.
- **regenerated shields faster than anything could strip them**, so the
  Doomsday Machine finished on 100% hull without the ship ever being in
  danger. Halved.
- **had a boss that could not hit anything**, because the antiproton beam
  tested the machine's aim cone and the machine turns at three degrees a
  second. It now commits to an aim point when the mouth opens and sweeps
  everything within 900 m of the path, which is both more dangerous and
  actually dodgeable.

The autopilot is the *floor*, not the target. It never uses evasive
manoeuvres, never moves power around, and never breaks off — so the numbers it
comes back with are roughly what a player who does nothing clever should
expect. Read them that way: episode one should say LOST, and everything else
should be won with real damage on the hull.

## Screenshots

```
node scripts/trek-shot.mjs shots/x.png --pose card
node scripts/trek-shot.mjs shots/gallery.png --all
node scripts/trek-shot.mjs src/assets/worlds/final-frontier.jpg --pose card --jpeg
```

The harness boots the route in `?shot=1`, dismisses the title card, spawns
whatever the pose asks for, and steps the engine deterministically. It refuses
to write a blank frame: on the software rasteriser a lost context produces a
perfectly plausible black JPEG, and a black JPEG committed as card art is worse
than no card art.
