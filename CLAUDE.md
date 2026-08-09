# vibe-explorer

The VibeVerse: a hub of worlds you can walk, fly, drive and shoot your way
through, each one reachable from the lobby at `/`.

## Working here

**Push straight to `main`.** Jack's standing instruction: no feature branch, no
pull request, no waiting for review — `main` deploys, and the point is to be
able to open a link and demo it a minute later. Commit to `main` and push.

The one thing that buys: **`main` is always live**, so verify before pushing,
not after. `npm run typecheck && npm run build` at minimum; for anything with a
canvas in it, drive the route in a real browser and look at the frame. A world
that builds and renders a black screen is a broken demo, and the build will not
tell you.

`npm run smoke` is the blunt instrument for that last part: it opens every
route in a real Chromium and reports which ones rendered nothing. It takes a
few minutes, it will not tell you a world looks *wrong*, and it is the fastest
way to find out that one of fifty routes stopped existing. `npm run smoke --
/sf /kart` for just the ones you touched.

**`npm run typecheck`, never bare `tsc --noEmit`.** The root `tsconfig.json` is
a solution-style config — `"files": []` plus project references — so `tsc
--noEmit` against it compiles *nothing* and exits 0 no matter what is broken.
And `vite build` strips types with esbuild without checking them. So a file
referencing an undefined variable passes both, ships, and white-screens the
route. That is not hypothetical; it went out that way once.

## Adding a world

The shape every recent world follows (Seafair, San Palmas, The Long Silence):

- A thin page in `src/pages/`, lazy-loaded from `src/App.tsx`, that owns the
  menus and mounts a container the engine renders into. Everything that moves
  lives in its own directory under `src/`.
  - **`lazy()`, not a plain import — always, however small the page looks.**
    Thirty routes were once imported eagerly, each of them small on the day it
    was added, and the sum was a 7.4 MB entry chunk: everybody who opened the
    grid of cards downloaded San Palmas, Vibe Golf, Vibe City and mapbox-gl
    before it painted. There is one `<Suspense>` around the whole router, so
    there is nothing to wire up; set `backdrop` in the registry if your world
    does not open on black.
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

## Somebody else's game, without vendoring it

Everything above is for a world that lives in this repository. There is a
second door — **the portal**, `src/portal/` — for a game hosted somewhere
else, by somebody else, that still pays out Vibey Coins and still sits inside
the vibeverse's chrome. Nothing above applies to it: no page, no registry
entry, no art, no lazy import. It is one row in `vibe_portal_games` and it
appears on the arcade shelf.

Reach for the portal whenever the game is not yours to maintain. Vendoring
means you own their bugs forever and they cannot ship an update without you;
that was the right trade exactly once.

The rule the whole thing rests on, and the reason it is safe to say yes to a
stranger: **a game never mints, it spends an allowance we hold.** It asks for
an amount and gets the smallest of that and four budgets. So approving a game
is deciding what it is worth per day — a number in a column — rather than
reading its source and hoping.

- The four ceilings and the wallet credit are one Postgres statement,
  `vibe_portal_award`, holding a lock on the session row. Do not move that
  arithmetic back into the edge function; it was there first, and eight
  concurrent asks against a 60-coin budget paid 96.
- The session id is the only capability that can move money. It is minted by
  `vibe-portal open`, lives in a closure in `src/portal/host.ts`, and is
  **never posted into the frame**. `src/test/portalHost.test.ts` asserts that,
  and asserts that a game supplying its own id is ignored.
- `origin: 'self'` means the game is served from our domain and is therefore
  *inside* the fence — it can read our localStorage like any script we ship.
  Only ever use it for a game in this repository.
- `public/vibeverse.js` is the whole SDK and is a public contract the moment
  anybody embeds it. Add to it; do not rename or re-shape what is there.
- `public/games/coin-drop/` is the reference game. It goes through the same
  sandbox, bridge and budgets as anybody else's, so it is the honest test: if
  it works, the path works.
