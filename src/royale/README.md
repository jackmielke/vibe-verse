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

## Conventions

- `+X` east, `+Z` south, `+Y` up. 1 unit = 1 metre.
- Engine events are namespaced `dz:` (`dz:lock`, `dz:hud`, `dz:eliminate`, …).
- The HUD reads engine events only. It never reaches into a system.
- `revive` is a declared `NetEventKind` that nothing in the browser sends or
  handles yet. The mode already has the numbers (`DRYNESS.reviveTime`,
  `reviveDryness`) and `player.ts` already stands you up if something heals
  you while you are down — the missing piece is the wire, and the teammate bot
  already speaks both halves of it.
