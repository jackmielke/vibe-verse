# HOME ALONE

671 Lincoln Avenue, Winnetka, Illinois, at Christmas. Route: `/home-alone`
(`/kevin` also works). The first of the vibeverse's films-as-worlds.

## The one decision everything else follows from

**The house is one continuous scene, and the stairs are real.** Basement,
ground floor and bedroom floor all exist at once, sixteen rooms of them, and
you walk between them. Nothing loads, nothing fades, no trigger volume swaps a
level.

That is the same call Five Nights made about the pizzeria, and it buys the same
things here:

- When Marv is coming up the stairs, he is on the stairs. You hear the boards,
  then you see him at the top, and nothing between those two facts is faked.
- A burglar's footstep volume is a function of a real distance to a real
  position, so "he's upstairs" is *information* rather than atmosphere.
- The light you left burning in Kevin's room lights the actual landing that
  Harry walks onto — and is visible from the street, which is the whole of
  level 2.

The cost is that height has to be solved rather than declared, and that is
`groundAt()` in `engine.ts`: **there is no "which floor am I on" flag.** Take
the highest floor slab or stair ramp beneath you that is within one step of
your feet. Walk off the landing and the ground under you becomes the hall
floor, so you fall into it. Walk up the flight and the ramp lifts you. Nothing
switches, which means nothing can switch *wrongly*.

## Files

| file | what it owns |
| --- | --- |
| `house.ts` | the floor plan — room rectangles, stair ramps, doorways, the nav graph, the eight traps |
| `textures.ts` | every surface and every face, drawn into a 2D canvas at boot. No image files |
| `build.ts` | the geometry: walls with holes in them, furniture, the street, the snow |
| `characters.ts` | Kevin, Harry and Marv, off one skeleton |
| `christmas.ts` | the lights, the garland, the wreath, the icicles — all instanced |
| `banter.ts` | every line anybody says, in shuffled bags |
| `traps.ts` | what each trap looks like armed, and what it does when it fires |
| `ai.ts` | five states and a breadth-first search |
| `audio.ts` | wind, boards, a furnace, and Shchedryk |
| `levels.ts` | the five levels, plus free roam |
| `engine.ts` | renderer, camera, the boy, the clock, and the loop that joins the above |
| `ui/HomeAloneHUD.tsx` | objective, compass, trap rail, nerve bars, and every touch control |

## It is third person, and that is not a preference

Home Alone is a film about watching a small child do something enormous. A
first-person camera throws that away — you would never once see the sweater,
the bowl cut, or him legging it down a corridor two sizes too big for him.

The cost is a camera that has to survive being indoors, and it is a real cost.
`settleCamera` pays it three ways:

- The boom shortens whenever a wall gets between the lens and his head, all the
  way down to 0.45 m. Anything more generous puts the camera *in* the wall in a
  1.6 m corridor.
- Below 0.95 m Kevin is hidden, so it degrades into a first-person view rather
  than a close-up of the back of his head.
- The boom is stopped by `camBlockers`, which is every wall **plus the glass and
  every hung door**. A window is a hole a player can never walk through, so it
  carries no collider — and the first build of this happily posted the lens out
  of the staircase window and rendered the back of the front wall.

## The five levels are five different verbs

The reason the film's third act lands is that you spent an hour watching a kid
be *alone* in a house before anybody came to take it off him. A game that opens
on the battle has thrown that away.

1. **Did I Make My Family Disappear?** — walk. Five places to find, one of them
   the furnace. No clock, no threat, and it is the tutorial by accident.
2. **The Wet Bandits** — hide. A grey van cruises Lincoln Avenue; every
   street-facing room still dark while it passes adds to what they think of the
   place. Light the house before they have seen enough.
3. **This Is My House** — build. Eight trap stations, one clock, and every one
   you skip is a room with nothing in it later.
4. **The Battle of the McCallister House** — run. You cannot fight them. You
   can only run past something you set up earlier, *on purpose*.
5. **Merry Christmas, Ya Filthy Animal** — escape. Nothing left, both of them
   still standing, one window and one wire.

There is also **free roam**, which is not a level. It exists because half the
people who open a link like this want to walk round the house with the lights
on and look at the tree, and telling them to clear level 1 first is a bad way
to greet a visitor.

## Christmas is doing more work than the floor plan

The single strongest nostalgia signal in the whole world is not the house or
the burglars — it is **a row of fat coloured bulbs along a gutter, in snow**.
Everybody has that image. So `christmas.ts` hangs a string along all four
eaves, a garland across the porch beam and spiralling down both columns, a
wreath with a bow on the front door, and a fringe of icicles with gaps in it
(a fringe without gaps reads as a comb).

Two decisions in there are worth stating:

- **The bulbs are geometry; the glow is not.** Two hundred and forty little
  emissive spheres cost nothing to shade. Two hundred and forty point lights
  would cost the frame. Six warm point lights spread along the front do the
  actual lighting and the bulbs are just bright dots — which, at night, in
  snow, is exactly what they are.
- **All of it is instanced.** The first cut used a `Mesh` per bulb, per cap,
  per icicle, per sprig: about seven hundred draw calls hung on the front of
  one house, which is more than the rest of the world put together. That is the
  classic shape of a thing that runs beautifully on a laptop and drops a phone
  to single figures. Instanced, the whole of Christmas is four draw calls and
  the twinkle is one buffer write per frame.

The twinkle is a slow **chase** along the string rather than a random flicker,
because that is what a 1990 controller box did, and random reads as a fault.

## The shout is the mechanic the battle turns on

You cannot fight them and you cannot outrun them. What you *can* do is stand at
the top of the stairs where the paint cans are hanging, **shout** (`Q`), and
make them come to you. Without it, leading two men onto eight specific spots is
a matter of luck; with it, it is a plan. It is also the most quoted thing in
the film, which is not a coincidence.

**Buzz's BB gun** is on his dresser upstairs in the battle and the escape. It
never knocks anybody down — it stings, staggers them for about a second and a
half, and takes five off their nerve. A gun that solved the problem would
replace the traps, and the traps are the game. What it buys is a head start and
a very satisfying noise.

## Old Man Marley

He shovels the pavement in the three quiet levels and never comes onto the
property, and he is *meant* to be alarming there: a tall stooped shape with a
snow shovel, who stops every so often and turns to look at the house.

Then, in the last level, the first time either of them gets hold of you, he
turns up. Once — it is a beat, not a mechanic, and a second one would just be
an extra life. It only works at all because you have spent four levels being
frightened of him, which is exactly the trick the film plays.

## The traps are fixed spots, not free placement

Free placement sounds better and plays worse. On a phone, aiming a trap at a
stair tread is miserable — and the fun of this sequence was never the aiming.
It is knowing the iron is waiting at the top of the cellar steps and running
that way *on purpose*. Every armed trap gets a shape that reads at ten metres
in the dark and a marker light that breathes, because a trap you cannot see is
a trap you cannot plan around.

Traps carry from level 3 into level 4. Starting level 4 straight from the menu
hands you five of them rather than an empty house, because an empty house is
unplayable and is not a lesson.

## The AI is five states and one graph

`prowl` · `hunt` · `search` · `down` · `flee`

Two rules make it work, and they pull against each other on purpose.

**They have to actually see you.** Vision is a distance, a cone and a segment
test against the same wall boxes you collide with. Standing behind the sofa in
the dark genuinely works — and if it did not, the trap game would be pointless,
because you cannot lead someone into a trap he has already found you behind.

**Sound carries.** Sprinting on bare boards is loud, carpet is not, and a trap
going off brings the other one running from two rooms away. Half of playing
this well is *walking*.

Nerve, not health: two good traps take one of them out of the fight, and he
leaves through the front door rather than dying, because nobody dies in this
film.

**And they talk.** Harry and Marv talk constantly in the film, and that is most
of why two men breaking into a house is funny rather than frightening. A silent
burglar is a horror-game monster; one who yells "you little jerk" from the
bottom of the stairs is a cartoon you are winning against, and the difference
is entirely `banter.ts`. Lines are picked by beat — entering, prowling,
spotting you, losing you, taking a trap in the face, giving up — with a
cooldown so they punctuate rather than chatter, and each character draws from a
shuffled bag so nothing repeats until it has to.

## Lighting is physical, and that bit you cannot guess

three.js has been physically based since r155. A point light's intensity is
candela and its falloff is a real 1/d^decay with none of the old fudge factor.
**A value that looked like a table lamp under the legacy model renders a black
room under this one.** Every interior in the first build of this house came out
as an unlit rectangle for exactly that reason. `ROOM_LUX` is 21 — a bare bulb
at two and a half metres.

The corollary is the sky. Nothing here casts shadows (sixteen rooms of shadow
maps is not something a phone will do), so a generous directional light shines
straight through the roof and daylights every interior. The moon is therefore
kept very low and **the inside of the house is lit entirely by its own bulbs,
its fire and its tree.** That is also the right answer artistically: the
contrast between a warm lit room and a blue-black one is the whole look.

## Texture scale is per metre, not per box

A `BoxGeometry`'s UVs run 0…1 on every face regardless of how big the box is,
so one shared wall material gives a five-metre wall and a one-metre wall the
same number of bricks. That is the single most reliable way to make a building
look like a game. `surface(kind, w, h)` in `build.ts` fixes it — ask for a kind
and the real size of the face, get a material whose texture repeats at a fixed
number of metres per tile, cached on a 25 cm grid.

## The controls, and the sign errors in them

Two of these shipped, and both are the kind that a screenshot cannot see and a
magnitude test passes happily:

- **The movement basis was negated on both axes.** Pushing the stick forward
  walked him *at* the camera and pushing right strafed him left, which on a
  thumb reads as "sometimes it goes backwards". The playtest checked that he
  moved; it did not check *where*. It checks all four directions now, and the
  basis is written out in the comment so nobody has to re-derive it:
  `forward = (sin y, 0, cos y)`, `right = (-cos y, 0, sin y)`.
- **Pitch fought the drag.** `dir.y` was negated against a `camPitch` that a
  drag increases, so swiping up the screen tipped the view down. Positive
  pitch is up. There is an invert toggle for people who want the other one.

**Touch has one owner.** The HUD used to hold a fixed joystick pad while the
canvas held the look-drag — two owners fighting over one thumb, with three
consequences: a thumb landing a centimetre outside the pad did nothing, a drag
starting on the left half was ignored, and a second finger had nowhere to go.
The engine now takes every pointer on the canvas: **left 45% is a floating
stick** whose centre is wherever your thumb lands, **right 55% is look**, and
**two fingers pinch to zoom**. The HUD only draws a ring where the engine says
the thumb is. Buttons stay DOM elements above the canvas and swallow their own
events.

The boom's height lift is proportional to its length. A fixed 42 cm is a
gentle over-the-shoulder angle at three metres and a view of the top of his
head at half a metre — which is exactly where a wall puts you.

**Nothing is locked.** Gating level 4 behind level 3 is right for a game
somebody bought and wrong for one somebody opened from a link: the reason to
post this is "come and see the bit with the paint cans", and that person
should not first be made to light seven rooms. A ☰ chip switches mode without
leaving the world.

## Faces are drawn

Kevin's face is a 512px canvas wrapped round the front of a squashed sphere,
and it is the highest-leverage decision in the world. No arrangement of boxes
was ever going to read as a specific blond eight-year-old.

Two things about that mapping cost a screenshot each to find:

- **Horizontally**, the drawing covers about 112° of circumference. Wider and
  it wraps round the skull and the eyes end up level with the ears.
- **Vertically**, it sits in a band around the equator rather than stretching
  pole to pole. Pole to pole puts the eyes under the hairline and crushes the
  mouth into the chin, because latitude near a pole covers almost no surface.

The bowl cut is three pieces — a shallow crown cap, a deep bowl over the **back
200° only**, and a fringe resting on the brow. A single hemisphere gives you a
gold egg with no face. A ring of boxes gives you a flat yellow slab from
behind. Three pieces give you a haircut. Every dimension in it is a fraction of
`headR`, and that is not tidiness: they were absolute metres once, and the day
the head got smaller the fringe stayed put and hung down past his nose.

Two more things about the face cost a screenshot each and are worth writing
down, because neither is guessable:

- **Clean skin round all four canvas edges.** The texture clamps, and the
  drawing occupies a band in the middle — so every part of the head outside
  that band takes the colour on the canvas *edge*. The edge was the dark outer
  stop of the form-shading gradient, and the whole lower head came out several
  shades darker than the cheeks.
- **The drawing sits low on the skull, not centred.** Centred, it leaves a
  hand's width of bare jaw below the mouth, and bare jaw on a head lit from
  above is a smooth dark wedge that reads as a goatee on an eight-year-old.
  That one is a *lighting* artefact, and the cure is not to fight the light —
  it is to stop having that much face below the mouth.

## Nobody is made of boxes any more

Limbs are tapered cylinders with a ball at every joint, and it is the single
biggest step from "assembled out of blocks" to "a person": a forearm 15%
narrower at the wrist than at the elbow reads as anatomy at a glance, where two
boxes of equal width read as furniture however good the texture on them is.
Hands and feet are squashed spheres, because a cube on the end of an arm is the
most obviously wrong thing a character can have.

The head is a sphere with four deformations, all of them things you would
notice missing before you could name them: the jaw narrows towards the chin,
the cranium is longer front-to-back than side-to-side, the brow steps forward
over the eyes, and there is a chin rather than the bottom of a circle. The UVs
are untouched, so the drawn face lands exactly where it did.

**Kevin is a fifth of his own height at the head, not a third.** The first
build used a third on the theory that children read as children by head-to-body
ratio. They do — but a third is a Funko pop, and he stopped being a boy and
became a mascot. The childishness has to come from everywhere else instead:
narrow shoulders, no waist to speak of, short forearms, and a stride that is
quick rather than long.

## Verifying a change

`npm run build` will not tell you the hall renders black, and it did.

    node tools/homealone-shot.mjs --set     # fifteen reference frames
    node tools/homealone-play.mjs           # drive all five levels, assert

The shot harness poses the camera by reaching into the engine — its fields are
private to TypeScript, not to the runtime, and walking to the basement to check
one beacon is a waste of thirty seconds a run. It waits on
`window.__homeAloneReady`, which is set **after** `begin()`, because `begin()`
re-spawns the player: racing it made every capture come out identical, at the
spawn point, which reads exactly like a broken camera.

The playtest asks `groundAt` and `resolve` directly rather than holding W and
hoping. It runs on SwiftShader at a handful of frames a second, where "hold W
for two seconds" measures the renderer rather than the game — and for the same
reason it waits on `engine.frames` and on the phase, never on a stopwatch. A
fixed millisecond wait is sometimes shorter than a single frame here, and then
the test presses against a stale prompt and switches off a room two rooms away,
which looks exactly like a level that cannot be won.

Bugs found this way, none of which the compiler could have found: the hall's
wallpaper facing Lincoln Avenue, every room lit as if the house had no roof,
the camera outside the front door, a bowl cut with no eyes under it, a fringe
across Kevin's mouth, a hall table standing squarely in the only doorway
between the front door and the stairs, and a porch garland that read as a
chain of coal.

## Teardown

`HomeAloneEngine.dispose()` stops the loop, unbinds input, releases the pointer
lock, closes the AudioContext, disposes every geometry, material and texture in
the scene, and forces the WebGL context loss. The house rule about leaking a
context is not theoretical: browsers cap live contexts, and the next world a
visitor opens is the one that breaks.
