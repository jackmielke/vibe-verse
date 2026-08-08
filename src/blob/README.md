# BLOB

The petri dish, at `/blob` (and `/agar`, `/agario`, `/cells`, because that is
what people type).

You are a cell. Everything smaller than you is food, everything bigger is a
problem, and the only real decision in the game is whether to spend half of
yourself on catching something that is running away.

## The map of the directory

| file | what it owns |
| --- | --- |
| `config.ts` | Every number the game is made of, each with a sentence saying what it buys. Start here for a tuning pass. |
| `types.ts` | Plain data. No methods, so the tests can build a cell out of a literal. |
| `rng.ts` | Seeded mulberry32. A match is reproducible from its seed, including bot decisions. |
| `spatial.ts` | Uniform grid. The reason a thousand pellets cost nothing. |
| `sim.ts` | All the rules. Knows nothing about a canvas. |
| `ai.ts` | The other twenty-four players. Four weighted vectors, summed. |
| `render.ts` | Canvas 2D. Membranes, sprites, camera, minimap. |
| `audio.ts` | Web Audio, synthesised. No files to download. |
| `engine.ts` | Loop, input, and the wire to React. |

The page is `src/pages/Blob.tsx` and it is thin on purpose: it mounts a canvas,
subscribes to a status object, and renders menus.

## Three things that are worth knowing before changing anything

**The sim is separate from everything else, and it must stay that way.** No
`document`, no `window`, no `Math.random` in `sim.ts` — the tests build a dish
and step it by hand in jsdom, and the moment a rule needs a canvas to be true it
stops being testable. Randomness goes through `sim.random()` so a seed replays.

**The loop is a fixed 60 Hz accumulator with interpolated rendering.** A
variable timestep would make a split lunge further on a 144 Hz monitor than on a
60 Hz laptop, which turns a frame rate into a competitive advantage. Every cell
carries `px`/`py` (its position at the top of the tick) so the renderer can draw
between states.

**Draw order for cells and viruses is one sorted list.** "Can I hide behind that
virus?" is answered by whether you are drawn under it, so the comparison the
renderer makes has to be the same one the sim makes. Splitting them into two
passes would look fine and quietly lie.

## Things that were wrong once, and are tested now

- **Merging was impossible.** Two halves of a split were shoved apart whenever
  they overlapped — including *after* the merge timer expired — and the shove
  held them at exactly touching distance, which is further apart than the merge
  test ever accepts. Two cells steered at the same point orbited each other for
  the rest of the match. Once the timer is up, overlap is allowed.
- **Bots grazed towards whales.** Threat avoidance fell off linearly over the
  bot's vision radius, so a predator four hundred pixels away was worth about as
  much as a nice patch of pellets. It is inverse-square-ish around a length
  scale set by the two bodies now, and the food and prey terms are suppressed by
  how frightened the bot is.
- **Player hues could be virus green.** A player wearing the colour of the thing
  that bursts them is a player who dies to their own camouflage.

## Verifying a change

`npm run typecheck && npx vitest run src/test/blob.test.ts` covers the rules, and
neither of them can tell you whether anything reached the screen. For that:

```
node scripts/blob-check.mjs /blob out.jpg          # desktop, plays for six seconds
node scripts/blob-check.mjs /blob out.jpg --phone  # 390×844, touch controls
```

It presses play, drives the mouse in a circle, splits twice, and reports console
errors, whether the frame has any colour in it, and the live HUD. A world that
builds and renders a black screen is a broken demo, and the build will not tell
you.

`/blob?shot` boots straight into a match with the HUD hidden, which is what
`scripts/route-shot.mjs` captures for the world card.
