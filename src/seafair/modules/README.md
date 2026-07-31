# Auto-registered world modules

Every `.ts` file in this directory is discovered by `GameWorld` at build time
via `import.meta.glob` and registered automatically. **Adding content to the
game never requires editing `GameWorld.ts`** — drop a file here and it runs.

This is what lets many people work on the world at once without touching the
same files.

## Contract

```ts
import type { GameModule } from "../ModuleTypes";

const mod: GameModule = {
  id: "hydroplanes",     // unique; also the dispose key
  order: 20,             // lower builds first; the default is 100
  build(ctx) {
    // ctx gives you scene, camera, renderer, terrain, water, sky, player,
    // colliders, profile, and rng. Build your meshes and add them to ctx.scene.
    // Return an optional per-frame update and a dispose.
    return {
      update(dt, elapsed) { /* ... */ },
      dispose() { /* free geometry, materials, render targets */ },
    };
  },
};

export default mod;
```

## Rules

- **Read your budget from `ctx.profile`.** Never hard-code instance counts,
  texture sizes or draw distances — the same file has to run on a phone.
- **Use `ctx.rng`,** not `Math.random()`, for anything that should look the same
  for every player.
- **Dispose everything you allocate.** Geometry, materials and render targets
  all leak otherwise.
- **Emit through the bus** (`bus.emit(...)`) instead of importing React.
- **Instance aggressively.** A hundred boats should be one draw call, not a
  hundred.
- Query the ground with `ctx.terrain.height(x, z)` and the lake surface with
  `ctx.water.sampleHeight(x, z)` so props sit correctly and boats actually ride
  the swell.
- Push an entry onto `ctx.colliders` for anything the player should not walk
  through.
