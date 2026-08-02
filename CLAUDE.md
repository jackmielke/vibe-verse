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
- Its route added to `CHROMELESS` in `src/App.tsx` if it owns the whole
  viewport — the global nav sits on top of a crosshair otherwise.
- An entry in `src/components/GlobalNav.tsx` and a card in
  `src/components/WorldPicker.tsx`.
- Card art that is a real capture from the running world. A world whose capture
  only ever produces a broken frame ships without art: misleading card art is
  worse than none.
- A way back to the hub from inside the world, shown when the player is not
  mid-action.
- Teardown on unmount — dispose the renderer, close audio contexts, remove
  window listeners. Browsers cap live WebGL contexts, and a world that leaks
  one breaks the *next* world a visitor opens, which is a miserable thing to
  debug.

Vendoring someone else's game? See `src/longsilence/README.md` — it documents
the four changes that took a standalone site and made it a route, and why each
one was necessary.
