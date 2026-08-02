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
behind. Three pieces give you a haircut.

## Verifying a change

`npm run build` will not tell you the hall renders black, and it did.

    node tools/homealone-shot.mjs --set     # twelve reference frames
    node tools/homealone-play.mjs           # drive all five levels, assert

The shot harness poses the camera by reaching into the engine — its fields are
private to TypeScript, not to the runtime, and walking to the basement to check
one beacon is a waste of thirty seconds a run. It waits on
`window.__homeAloneReady`, which is set **after** `begin()`, because `begin()`
re-spawns the player: racing it made every capture come out identical, at the
spawn point, which reads exactly like a broken camera.

The playtest asks `groundAt` and `resolve` directly rather than holding W and
hoping. It runs on SwiftShader at a handful of frames a second, where "hold W
for two seconds" measures the renderer rather than the game.

Bugs found this way, none of which the compiler could have found: the hall's
wallpaper facing Lincoln Avenue, every room lit as if the house had no roof,
the camera outside the front door, a bowl cut with no eyes under it, and a
fringe across Kevin's mouth.

## Teardown

`HomeAloneEngine.dispose()` stops the loop, unbinds input, releases the pointer
lock, closes the AudioContext, disposes every geometry, material and texture in
the scene, and forces the WebGL context loss. The house rule about leaking a
context is not theoretical: browsers cap live contexts, and the next world a
visitor opens is the one that breaks.
