# FIVE NIGHTS AT VIBEY'S

Midnight to 6 AM in Vibey Fazbear's Pizza. Two doors, two lights, eleven
cameras and one battery. Route: `/fnaf` (`/five-nights` also works).

## The one decision everything else follows from

**There is a single 3D scene, and the security cameras are cameras standing in
it.** The whole restaurant — twelve rooms, every wall — exists at once, laid
out on one floor with the office at the origin. Raising the monitor does not
switch scenes; it switches which `PerspectiveCamera` draws the frame.

The original cut between pre-rendered stills, which was a budget decision that
became a style. Doing that here would have been *easier* — eleven small
dioramas, no pathing, no navmesh, no risk of anybody clipping a wall on camera.
It was rejected because of what one scene buys:

- Bonnie is genuinely halfway down the west hall on camera 2A, mid-stride, and
  eight seconds later he is genuinely at your door. Nothing between those two
  facts is faked.
- A footstep's volume is a function of a real distance to a real position
  (`FnafAudio.step(dist)`), so "that was close" is information rather than
  atmosphere.
- Turning the hall light on lights the actual patch of floor something actually
  stands on. The reveal is a light, not a sprite swap.

The cost is that everything which moves has to path. `pathBetween` in
`rooms.ts` is the navmesh: twelve links, breadth-first, and it is twelve lines
long because the building is twelve rooms with one door each.

## Files

| file | what it owns |
| --- | --- |
| `rooms.ts` | the floor plan — bounds, ceiling heights, camera poses, the room graph |
| `textures.ts` | every surface, drawn into a 2D canvas at boot. No image files |
| `build.ts` | the geometry: walls with holes in them, props, lights, doors, buttons |
| `animatronics.ts` | the four of them, built from boxes and spheres, with a gait |
| `vibey.ts` | Vibey — the fifth one, and the only one pleased to see you |
| `ai.ts` | the director: routes, d20 rolls, door timers, Foxy's cove stages |
| `engine.ts` | renderer, clock, power, input, and the loop that joins the above |
| `ui/FnafHUD.tsx` | clock, battery, thumb-sized buttons, and the monitor overlay |
| `ui/VibeyChat.tsx` | the desk intercom, on the same `unit7-chat` brain as Vibe City |

## The AI is three lines of arithmetic

Each character carries an **AI level** from 0 to 20. Every few seconds it rolls
a d20; under its level, it takes one step along its route graph. That is the
entire system, and it is the original's, because it is a very good one — the
pauses, the sudden rushes, and the night where Bonnie will not leave your door
all fall out of a dice roll and a graph.

Three characters break the pattern:

- **Freddy** will not move while you are looking at the camera he is on, and
  will not leave the stage until one of the others already has. He is the
  reason a blackout is fatal. He also goes *anywhere* — the original's Freddy
  owns one corridor, and here that made him a slower Chica: once you knew the
  game you never checked the west side for him. His graph now covers every room
  including the supply closet and the kitchen, and he can arrive at either
  door.
- **Foxy** doesn't walk a route. He advances through four stages behind the
  Pirate Cove curtain — which physically parts as he does, the only warning the
  game gives that is purely visual — and then sprints the west hall. A shut west
  door costs battery instead of your life, and costs more every time.

- **Vibey** is not an animatronic at all — see below.

Night 1 in the original is all zeroes. Here it is `{freddy: 0, bonnie: 2,
chica: 1, foxy: 1}`, because zeroes are correct for a game you will play for a
week and wrong for one somebody opens from a link: the first thing night 1
should teach is that the doors matter.

## Vibey

The vibeverse's own mascot has wandered in, and he is the fifth thing moving
around the building. He plays by exactly the same rules as the other four — a
d20, a route graph, doors that stop him — and the director drives him through
the same `Animatronic` contract with no special cases. Everything else about
him is different on purpose.

**He is built, not loaded.** The obvious move was `/models/vibey.glb`, the file
Vibe City and the village map share. That model is a *humanoid* robot with arms,
legs and feet; the Vibey in the reference photo is a different design — rounded
white head, two goggle lenses on a bridge, two coiled antennas, an egg body
wearing a lightning-bolt smiley, sat on a dark ring. The photo was the brief, so
the photo is what `vibey.ts` builds. It also downloads nothing, which is not
nothing on a phone.

**He scoots.** No legs, so no gait: a disc under him spins with travel, he hops,
and he lands with a squash. His route graph has no forward weighting either, so
he doubles back and visits empty rooms — he reads as pottering about rather than
closing in.

**Being caught by him is a party.** No scream, no static, no red. He says hi,
the room fills with confetti, a major arpeggio plays, and he says bye. Your
night still ends — he is a hazard, not a bonus — but this ending is a curtain
call, and he bounces facing you rather than filling the lens with teeth. One of
the five should be a delight to meet.

**You can talk to him.** The desk has an intercom, on the same `unit7-chat` edge
function as Vibe City, Jerry the snail and the `/start` onboarding — the same
brain, given a line about where he currently is. The night does not pause while
you type, which is the trade. The engine ignores keystrokes aimed at a form
field for exactly this reason: without that guard, messaging him the word
"door" slams both of them.

## You do not leave the office

`W`, `S` and the arrow keys are bound, and what they do is print a line saying
no. The chair swivels ±0.83 rad and that is the entire movement system. This is
load-bearing rather than lazy — the game is about the two metres either side of
you and a battery, and a player who can walk out into the hall is playing a
different, worse game.

`YAW_LIMIT` is 0.83 for a specific reason: the doorways sit 43° off the desk's
centreline, so anything tighter means you can never put a door in the middle of
the screen, and checking a door is the thing you do most.

## Power is a budget of moves, not a clock

**Nothing drains over time.** Not while you idle, and not while a door is held
shut or the monitor is held up. Power is charged once, at the instant you
commit to something:

| action | cost |
| --- | --- |
| dropping a door | 5% |
| striking a hall light | 2% |
| checking the cameras | free, capped at 30 seconds up, then a 6-second reboot |
| Foxy hitting a shut west door | 3% + 1% per previous charge |

Opening a door and killing a light are free too — nothing should punish you for
undoing a decision, because that is a drain by another name.

**The cameras are free outright** — but they are rate-limited. Watching is how
you find out where everything is, and a price on watching teaches players to sit
blind in the dark and hope, which is a worse night than the one where you can
see exactly what is coming and cannot afford the door. So looking costs nothing; what
the game takes instead is time, in two parts:

- **Thirty seconds up.** The monitor runs an uptime clock, shown as a bar
  across the top of the feed and a countdown by the REC light. At zero the
  system faults out on its own and drops you back into the office.
- **Six seconds down.** Whichever way the monitor went down — your thumb or the
  fault — it will not come back for six seconds.

That is a better sentence than a price. A cost says "you may look forty more
times tonight"; the cooldown says "you cannot look for the next six seconds",
which lands in the moment you actually feel it — right after you have swept the
halls and something moves.

The thirty-second cap is aimed at a different problem than the reboot is. The
reboot stops you *spamming* the cameras; the cap stops you *hiding* behind
them. Parking on a feed was the one way to opt out of the game — nothing can
reach you while you are not in the room — and thirty seconds is deliberately
generous, long enough to sweep every room twice, because the limit is not there
to stop you looking. Both also give Foxy real teeth: he advances whenever
nobody is watching the cove, and you can no longer watch it on demand.

Only the fault puts an error on the screen. Dropping the monitor yourself is a
decision and timing out is an accident, and the interface should not confuse
the two.

This is a deliberate departure from the original, and it changes the question
the game asks. FNAF bills you by the second, so the question is *can you afford
to keep this shut*. Here the battery is twenty door closes, or fifty light
flicks, or any mix of the two, and the question becomes *was shutting that door
worth five percent*. Both are good questions; this one
was Jack's call, and it has the advantage that the meter never moves unless you
moved it.

The cost of the trade is worth stating plainly, because it is the first thing a
player will find: **you can shut both doors at 12 AM for 10% and survive the
night doing nothing.** If that ever needs closing, the honest fix is a
per-second cost on a *held* door and nothing else — that is the one place the
original's model earns its keep — not a general idle drain.

At 0% the doors open themselves, the building goes dark, and Freddy plays you
the Toreador March — Bizet, public domain, and always the joke: the most
cheerful possible thing to hear in the dark.

## Teardown

`FnafEngine.dispose()` stops the loop, unbinds input, closes the AudioContext,
disposes every geometry, material and texture in the scene, and forces the
WebGL context loss. The house rule about leaking a context is not theoretical:
browsers cap live contexts, and the next world a visitor opens is the one that
breaks.

## Verifying a change

`npm run build` will not tell you the office renders black. Drive the route in
a real browser and look at the frame — the office, one hall camera, and one
animatronic under a hall light are enough to catch nearly everything. Every
visual bug found while building this was found that way and none of them were
found by the compiler: a wall built twice in the same plane, a jumpscare facing
backwards, three animatronics standing shin-deep in the show stage, and a
wallpaper gradient that tiled into a grey band across every wall in the
building.
