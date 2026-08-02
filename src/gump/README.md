# RUN, VIBEY, RUN

A whole life, at a run. Six chapters — the road out of Greenbow, a kickoff
return, the treeline, a ping-pong match, the shrimp boat, and then across
America — with the timeline of them across the top of the screen the entire
time you are playing.

Route: `/run` (aliases `/gump`, `/forrest`). Page: `src/pages/RunVibeyRun.tsx`.

## Why it is shaped like this

**Five of the six chapters are one file.** `runner.ts` is a running game
parameterised by `RunSpec`, and `chapters.ts` is six specs. A dirt road in
Alabama, a football field, a jungle track, the open gulf and a highway across
Arizona differ in their palette, their scenery, what is in the way and what is
behind you — and in nothing else. Writing them five times would have produced
five subtly different jumps.

The exception is `pingpong.ts`, which is genuinely a different game and does
not pretend otherwise.

**You never move.** The runner is pinned at the world origin and the world is
dragged past him. That is why there is no tile recycler anywhere here, no seam
to hide, and no floating-point drift after five kilometres. Everything that
exists lives in `z ∈ [-220, +30]`; anything that leaves goes into a pool.

**The floor is two planes.** A terrain plane 420 m across with a texture that
tiles in both directions, and a road strip on top of it at exactly the width
the chapter wants, carrying a cross-section — shoulders, ruts, the centre line,
yard lines. One plane with one cross-section texture ties the width of the road
to the width of the world, and you get either a ninety-metre-wide highway or
trees hanging in the air past the edge of a mat. Both were tried. Both looked
exactly as bad as that sounds.

**Speed is the whole game.** The obstacles exist to take speed away from you,
and every beat in the story is about getting it back. So speed drives the
stride length, the camera's field of view, the shake, the music and how close
the thing behind you is. Lose speed and you feel five things at once.

**Everybody is made of boxes.** `rig.ts` builds one humanoid and re-skins it
into a boy in leg braces, a running back, a soldier, a captain and a bearded
man crossing America. The run cycle is driven by *distance travelled*, not by
time — feet planted per metre is what makes the stride stretch when you sprint
instead of the legs spinning under a body that is barely moving.

**The crowd is instanced.** Forty followers as forty rigs is eight hundred
meshes. `crowd.ts` is six `InstancedMesh`es and one dummy matrix: six draw
calls whether there is one of them or a hundred.

**The engine owns its canvas.** It is handed a container `<div>` and makes the
`<canvas>` itself, because teardown calls `forceContextLoss()` to hand the GPU
back immediately — and a canvas whose context has been force-lost will never
give out another one. Passing in a React-managed canvas works exactly once:
walk out to the hub and come back, and the second mount gets `null` from
`getContext` and a world that claims it failed to boot. That is what "teardown
on unmount" in the house rules is protecting against, from the other side.

## The files

| file | what is in it |
| --- | --- |
| `engine.ts` | Renderer, clock, input, sky, chapter lifecycle, and the bench |
| `runner.ts` | The running chapter — five of the six beats |
| `pingpong.ts` | The sixth, with a ball that has real physics |
| `chapters.ts` | The six specs, and the timeline the HUD reads |
| `rig.ts` | Everybody, out of boxes |
| `crowd.ts` | The people running behind you, instanced |
| `props.ts` | Everything that is not a person |
| `textures.ts` | Every surface, drawn into a canvas at boot |
| `audio.ts` | Every sound, synthesised. There is a tune |
| `ui/GumpHUD.tsx` | The timeline, the readouts, and the cards between chapters |

## The bench

The story is told from a bus stop, so the title screen *is* the bus stop — a
live scene with Vibey sitting on the bench, a box of chocolates beside him and
a feather drifting down. `toBench()` returns there between chapters. It is the
framing device the film is built on, and it costs about sixty lines.

## Controls

Desktop: `A`/`D` steer, `Space` jumps (hold it for height) and swings the
paddle, `Shift` runs flat out. Touch: drag to steer, tap to jump or swing, a
second finger anywhere for speed — plus two buttons in the HUD, because a
gesture nobody is told about is a gesture nobody uses.

## Checking it before you push

`main` is always live, so this is not optional:

```
npm run build
node scripts/gump-shot.mjs /tmp/gump 6   # boots every chapter, screenshots each
node scripts/gump-deep.mjs /tmp/gump-deep # plays every chapter to the end
```

`gump-deep` uses two dev seams on the engine — `timeScale` and
`debug.immortal` — that exist only so a harness can reach the beat at 80% of a
five-kilometre chapter without a human sitting through it. Nothing a player can
touch sets either one. Look at the JPEGs afterwards; a chapter that builds and
renders a black screen is a broken demo and the build will not tell you.
