# DROP ZERO — the vibeverse battle royale

Route: `/drop-zero` (aliases `/royale`, `/br`). Page: `src/pages/DropZero.tsx`.

## The shape

Same `System` architecture as `src/palmas/`. Read `types.ts` first — it is the
whole contract. Every module is a `SystemFactory`: it takes `WorldCtx`, does
its setup, publishes its service into `ctx.services`, and returns
`{ name, update?, fixed?, lateUpdate?, resize?, dispose? }`.

**Systems never import each other.** They read `ctx.services.<x>` lazily,
inside `update`, because the service may not exist yet at factory time and may
have failed to boot at all. Always null-check.

`boot.ts` is the single source of truth for load order.

## The art direction

Fortnite, not realism. That is a specific, disciplined look and it is what
"AAA" means here:

- **Saturated but not garish.** Deep grass greens, warm sand, terracotta
  roofs, a strong blue sky. Colour comes from albedo and light, never from
  post-processing tint dialled up to hide flat shading.
- **Stylised PBR.** Real normal maps, real roughness variation, real ambient
  occlusion — but chunky, readable forms with slightly exaggerated proportions.
  Roughness variation is what separates AAA from a Three.js demo: a surface
  with uniform roughness reads as plastic no matter how good the albedo is.
- **Silhouette first.** Every structure must read at 300 m. Big shapes, strong
  colour blocking, and a distinct roof colour per POI so the map is legible
  from the bus.
- **Light does the work.** One warm key sun with proper cascaded shadows, a
  cool sky-ambient fill, and honest bounce. Never `MeshBasicMaterial`, never a
  flat `AmbientLight` at full strength — that is the single most common thing
  that makes a web game look cheap.
- **Volume in the air.** Aerial perspective (distance haze that tints toward
  the sky colour), god rays through the treeline, dust motes near the ground.
  A landscape with no atmospheric depth looks like a diorama.

## Rules that are not negotiable

1. **No external assets.** No CDN fetches, no GLTF downloads, no texture URLs.
   Everything is generated in code — geometry procedurally, textures on
   canvas/data-textures at boot. The world must run offline and the repo must
   not gain binary assets.
2. **Dispose everything.** Every geometry, material, texture, listener,
   `setInterval` and `AudioContext` you create gets torn down in `dispose()`.
   Browsers cap live WebGL contexts, and a leaked one breaks the *next* world
   a visitor opens.
3. **Instance aggressively.** Thousands of trees/rocks/props means
   `InstancedMesh` with per-instance colour, or merged `BufferGeometry` per
   material. A draw call per object will not hold 60 fps.
4. **Budget: 60 fps at 1600×900 on `quality: "high"`.** Scale your cost off
   `ctx.quality`. Target under 900 draw calls for the whole frame.
5. **Fixed step for anything physical.** Movement, build placement and
   projectiles go in `fixed(dt)` (hard 120 Hz). Cosmetics go in `update(dt)`.
6. **Comment like the rest of this repo.** Explain *why*, especially the
   non-obvious tuning constants. Do not narrate what the code plainly says.

## The map

A 3 km × 3 km island, sea on all sides. Named POIs, each visually distinct,
each with a roof-colour identity and a loot tier. Roads connect them. The
terrain is authored so POI floors land on multiples of `GRID` (4 m), because
players build off them.

## The third game: BETTER FORTNITE

Route: `/better-fortnite` (aliases `/better`, `/bf`). Page: `src/pages/BetterFortnite.tsx`,
which stamps its passport and renders the same `RoyalePage` as the other two.

`ctx.mode === "better"` is Drop Zero's bullets and health plus four systems the
other two games never load. They boot straight after input (see `BETTER_STAGES`
in `boot.ts` for why that position is load-bearing), and every number for all
four lives in `mode/better.ts`:

- **Augments** (`play/augments.ts`) — a hand of three perks a few times a
  match, taken with 1/2/3 or a tap. Nothing applies them: weapons, building,
  the storm and the player each multiply their own constant by
  `augments.factor(key)` at the moment they use it, and read 1 when the
  service is absent. That is the whole reason the other modes are unchanged.
- **The grapple** (`play/grapple.ts`) — F. A velocity you are steered onto, not
  a pendulum. It boots before the player so its pull is integrated.
- **Second wind** (`play/secondwind.ts`) — the first down is a countdown and a
  redeploy over the circle, once. The player system asks `claim()` at the
  moment it would start the bleed-out and, if taken, stops counting; this
  system counts, and calls `player.redeploy()` at zero. One clock.
- **Island events** (`play/events.ts`) — one per circle: a supply storm, low
  gravity, nightfall, shield rain, sudden death. Every effect is a one-liner
  against a service that already existed.

`npm run dz:play` with `DZ_ROUTE=/better-fortnite` runs four extra beats that
drive each of these with real input where a player can and the documented
debug entry points (`augments.offerNow()`, `events.trigger()`) where the
schedule would otherwise cost minutes of simulated time.

## Playing as somebody

All three games open on a locker (`ui/Locker.tsx`): the vibeverse roster —
the Quaternius GLBs, Vibey, the code-built cast — plus the island's own Drop
Suit. Picking is `setActiveCharacter`, the same pick the city and the profile
use, so who you are here is who you are everywhere. The one exception is the
suit, which is a flag of this world's (`skinChoice.ts`) rather than a roster
id, so choosing it never turns you into somebody random elsewhere.

`play/skin.ts` loads the pick through `loadCharacterRig` — the loader every
other world uses — and hands it to `player.setSkin()`. The player keeps
SIMULATING the drop-suit (every step, the foot plant, the glider) and only
hides its meshes: the skin is a costume over an actor, not a replacement for
it. It drives the skin's clips off the same state the body animates from
(idle↔walk by speed, the jump clip in the air, the death clip when down) and
plants a node named `dz-hand-r` on the skin's right hand, which is how the
third-person weapon finds a hand on a skeleton it has never seen.

**The fit is measured off a render, not a bounding box.** No box is honest
for every rig in the catalog: the Quaternius armatures draw from their bones
at twice their bind box and standing on the origin, the Esmeralda pirates
box at twice their drawn size, and fitting either from geometry put the
first family's boots at the top of the turntable and the second at half
height. `refitByRender` in `src/lib/characterRig.ts` draws the rig once,
flat white, into a 96×128 offscreen target and reads the alpha back; the
skin and the locker preview both rescale and re-plant from that. Under
SwiftShader that first frame can take forty seconds to show; the harness
waits for it, and a blank turntable in a capture is the wait, not the fit —
`window.__previewFit` says what the fit decided.

Bots and remote players still wear the drop-suit. The pick does not travel
over the wire yet.

## The lido

`world/lido.ts` is a water park on the east coast — slide tower, wave pool, a
163 m lazy river, splash pads, a diving stack. It is the one POI that is a
*place* rather than a street, and it is where the water game's own vocabulary
is at home: `lido.flowAt()` returns the lazy river's current, so anything that
floats gets carried, and the deck is topped up wet round-robin because puddles
evaporate and a park that is bone dry ninety seconds in is not a lido.

**It must boot before `props` and `vegetation`.** Both plant into open ground,
and neither knows the park is coming — run it after them and there are trees in
the wave pool. That ordering is the reason it sits where it does in `boot.ts`
and it is not a detail you can reshuffle.

`npm run dz:shot -- lido lidodeck` are the two vantages that show it.

## The build loop

This is the thing that makes it Fortnite and not a shooter. It has to feel
instant: pickaxe a tree → wood counter ticks up → tap Z → a wall snaps to the
grid in front of you and rises to full HP in ~0.4 s. Placement preview is
green when valid, red when blocked. Ramps let you climb. Everything you build
is destructible and structural — shoot the wall under a ramp tower and the
tower comes down.

## The third squadmate

`scripts/dz-teammate.mjs` joins a Splash Royale lobby from the command line and
plays it — follows, fights, talks, revives, and stays for the next match.

```bash
npm run dz:teammate -- --room SPLASH-4B2 --name Claude --team dolphin
```

Nothing in this directory knows about it. It joins the same Supabase Realtime
channel `net.ts` uses, as an ordinary peer whose presence meta happens to carry
`agent: true`, and every code path in the game treats it as a player. **Do not
add a bot hook here.** The reason it cannot break the game is that the game has
never heard of it.

Two things worth knowing before you change either side:

- **It keeps a training record** in `.dz/skill.json` (gitignored) — seven
  decisions about how to fight, each an independent bandit scored on the soak
  actually traded. `npm run dz:report` prints what it has worked out.
  Delete the file and it is a beginner again.
- **It plays under caps it cannot learn past** — a reaction-time floor, an
  engagement range, an accuracy ceiling, this mode's own drying rate, and no
  teleporting except onto the drop bus. They are in `FAIR` at the top of the
  script, with the reasoning. If you give the bot something new to do, it goes
  under those, not around them.

`npm run dz:selftest` runs the whole brain offline against scripted peers — no
socket, no lobby, no Supabase config. Run it before you touch the script.

Two instances on different squads will fight each other, which is both the
easiest way to test a change end to end and how the bot trains when nobody is
online.

## When a frame looks wrong

`scripts/dz-ground.mjs` raycasts a grid over the frame and reports, per cell,
the object the ray hits, its material, and the luminance actually rendered
there — plus its own screenshot from the same instant.

```bash
DZ_PORT=5195 node scripts/dz-ground.mjs lidodeck
```

Reach for it before changing a shader. Four separate theories about one dark
patch of ground — dark ground cover, a canopy underside, a shadow-map artifact
and a metalness bug — all predicted the same photograph, and two of them were
confidently wrong. In particular: **every material in this world reads
`metalness: 1`**, because the library binds one ORM texture and lets its blue
channel modulate. The scalar on its own says the island is made of polished
metal. It is not a bug and it has nearly been "fixed" once.

## Conventions

- `+X` east, `+Z` south, `+Y` up. 1 unit = 1 metre.
- Engine events are namespaced `dz:` (`dz:lock`, `dz:hud`, `dz:eliminate`, …).
- The HUD reads engine events only. It never reaches into a system.
- `revive` is a declared `NetEventKind` that nothing in the browser sends or
  handles yet. The mode already has the numbers (`DRYNESS.reviveTime`,
  `reviveDryness`) and `player.ts` already stands you up if something heals
  you while you are down — the missing piece is the wire, and the teammate bot
  already speaks both halves of it.
