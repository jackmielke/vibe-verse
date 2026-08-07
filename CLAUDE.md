# vibe-explorer

The VibeVerse: a hub of worlds you can walk, fly, drive and shoot your way
through, each one reachable from the lobby at `/`.

## Working here

**Push straight to `main`.** Jack's standing instruction: no feature branch, no
pull request, no waiting for review — `main` deploys, and the point is to be
able to open a link and demo it a minute later. Commit to `main` and push.

The one thing that buys: **`main` is always live**, so verify before pushing,
not after. `npm run build` at minimum; for anything with a canvas in it, drive
the route in a real browser and look at the frame. A world that builds and
renders a black screen is a broken demo, and the build will not tell you.

## Adding a world

The shape every recent world follows (Seafair, San Palmas, The Long Silence):

- A thin page in `src/pages/`, lazy-loaded from `src/App.tsx`, that owns the
  menus and mounts a container the engine renders into. Everything that moves
  lives in its own directory under `src/`.
- **One entry in `src/worlds/registry.ts`.** That is the whole list — the nav,
  the picker, `/game`, the hub carousel and the passport are all views of it, so
  a world added there shows up in all of them at once. Do not start a seventh
  list; six was already too many, and they disagreed.
  - `chromeless: true` if it owns the whole viewport — the global nav sits on
    top of a crosshair otherwise. Aliases are covered automatically.
  - `passport: true` **and** a `useWorldStamp` call in the page, together. A
    test fails if only one of the two is there.
  - `source` is not decoration — `npm run stamp` reads it to work out when the
    world last changed, and that date is on every card. Point it at the code,
    and run `npm run stamp` before you push.
- Card art that is a real capture from the running world
  (`node scripts/route-shot.mjs /<route> src/assets/worlds/<key>.jpg`, then a
  line in `src/worlds/art.ts`). A world whose capture only ever produces a
  broken frame ships without art: misleading card art is worse than none.
- A way back to the hub from inside the world, shown when the player is not
  mid-action.
- Teardown on unmount — dispose the renderer, close audio contexts, remove
  window listeners. Browsers cap live WebGL contexts, and a world that leaks
  one breaks the *next* world a visitor opens, which is a miserable thing to
  debug.

Vendoring someone else's game? See `src/longsilence/README.md` — it documents
the four changes that took a standalone site and made it a route, and why each
one was necessary.
