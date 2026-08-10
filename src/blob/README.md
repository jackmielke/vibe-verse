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
| `course.ts` | The phone control: flick a heading, let go, keep going. Pure, so it is tested. |
| `render.ts` | Canvas 2D. Membranes, sprites, camera, minimap. |
| `audio.ts` | Web Audio, synthesised. No files to download. |
| `engine.ts` | Loop, input, and the wire to React. |
| `net/session.ts` | The multiplayer protocol, with no idea what a socket is. |
| `net/supabase.ts` | The one file that does. Dynamically imported; allowed to fail. |

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

**A phone sets a course, it does not hold a stick.** Flick a direction, let go,
and you keep going until you set another one or tap to stop. Holding a thumb
down for a whole match is tiring and it covers the dish you are trying to read.
The maths is `course.ts` and it is pure, so it is unit tested; whether it is
*wired* to the pointer events is checked by `blob-check.mjs`, which drags,
lifts, and watches where the blob goes.

**Draw order for cells and viruses is one sorted list.** "Can I hide behind that
virus?" is answered by whether you are drawn under it, so the comparison the
renderer makes has to be the same one the sim makes. Splitting them into two
passes would look fine and quietly lie.

## Multiplayer

A room code, texted to a friend. `?room=CODE` is the invite, and the address bar
is kept in step with it so the link *is* the invite.

Four rules, and the whole design follows from them:

1. **Your blob is yours.** You simulate it, you broadcast it at 12 Hz, nobody
   else ever moves it.
2. **A bite belongs to the eater.** Both clients compute the same rule from
   slightly different positions, so if both applied it you would get two screens
   that disagree about who survived. The eater resolves it and names the cells;
   the victim removes them.
3. **The bots belong to the host** — whoever has the lowest peer id, derived
   rather than elected, so it survives the host closing their laptop. Run
   independently the bots diverge within seconds and you end up watching a
   friend get eaten by a blob that is, on your screen, somewhere else.
4. **Pellets are nobody's**, and are the one thing allowed to drift. Two players
   may see slightly different crumbs. Nothing about that changes who is bigger,
   and syncing three thousand pellets to fix it would cost more than the rest of
   the protocol put together.

The seed comes from the room code, so everybody lays out the same dish before a
word is exchanged. A room is Free for All on Standard: the bot roster has to
match, because bots are addressed by player id.

The transport is an interface. `blobNet.test.ts` wires two sessions together
over an in-process loopback and plays a match between them, so the protocol is
tested without a socket. The Supabase implementation is three lines of channel
code, the same shape as Vibe City, Vibe Kart and Soaked, and it is allowed to
fail: if the room cannot be reached, `netState` goes to `failed` and the game is
exactly the single-player game it was.

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
- **The eater did not tombstone its own kill.** A victim's last state packet was
  already in flight when it was eaten, landed a frame later, and put the blob
  back on the table until the next update removed it again. The loopback test
  caught it; reading the code did not.
- **Every room join hung on "joining…".** `joinRoom` took its guard token and
  *then* called `leaveRoom`, which bumps the same counter — so the token never
  matched afterwards and every join bailed out at the guard with no error
  anywhere. Only driving the real UI in a browser found it.

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
