# THE VIBEVERSE — vendored from THE LONG SILENCE

Anshu Chimala's procedural space-exploration game, from
[github.com/achimala/TheLongSilence](https://github.com/achimala/TheLongSilence)
(MIT — the licence travels with the code, in `LICENSE` beside this file),
remixed into the hub's front door.

## The remix

The original is a game about an absence: nine hundred worlds went quiet forty
thousand years ago and you fly out alone to find out why. Here the premise is
inverted — the band is crowded, every world is lit, and three of the stars on
the chart are places you can actually go — four of them now.

- **`world/vibeworlds.js`** is the whole registry. Four entries today — San
  Francisco, Seafair, Vibe Island II and EDM Town — each naming a star system,
  fixing its place on the chart, and hand-authoring the planet inside it:
  palette, sea level, cloud deck, night-side city lights. EDM Town also carries
  its own lamp colours, so its night side burns magenta and cyan rather than
  sodium and LED. From orbit each one should look
  like the world it leads to, because a visual promise is the only promise a hub
  can make from that distance. Adding a fourth is one object and nothing else.
- **`generate.js`** grows a `stub.world` branch. World systems take their name,
  star class and chart position from the registry and swap the planet nearest
  the habitable zone for the authored one. Every `rnd()` draw still happens even
  where its result is discarded — the generator is one deterministic sequence,
  and skipping a draw would rearrange the rest of the galaxy the day a world is
  added.
- **`Game._maybeHandOff`** is the payoff. Touchdown on a planet carrying a
  `worldRoute` waits out the landing sequence — the descent is the best thing
  in the game and cutting away at gear-down would waste it — then calls
  `onEnterWorld`, which the React page turns into a navigation. Lifting off
  first cancels it, because changing your mind has to work.
- **The voice** was rewritten rather than search-and-replaced. The ship is
  VIBEY, the seven Resonators are Relays that still carry traffic between
  worlds, and the Cantos read as an invitation instead of an epitaph. The Choir
  survived the flip intact: they built the network and moved next door, which is
  a better story than dying and costs nothing to tell. The opening lines are a
  function of the player's name, read from `useVibeIdentity`.

Upstream's mechanics are untouched — scanning, the fold drive, the walkable
cabin, the seven-relay arc. Only what the game is *about* changed.

## The archive terminal

The port-wall display — the biggest screen in the ship and the only one you
have to leave the seat and walk to — shows the vibeverse's own records rather
than the ship's opinion of itself. Six pages, cycling while somebody is stood
at the station, `N` to page by hand:

| page | source |
| --- | --- |
| THE GALLERY | `gallery_photos`, crossfading, captioned |
| YOUR PASSPORT | `localStorage`, written by every world in the repo |
| WHO LIVES HERE | `users` — 10,089 people, 7,878 of them with bios |
| THE TREASURY | `vibe_balances` + `vibe_ledger` |
| THE MANIFEST | `users` beside `world_agents` in the lobby |
| THE BAND | `world_messages`, scrolling |

Two rules hold this together and both are load-bearing:

**The engine never learns what Supabase is.** `src/longsilence` is a vendored
fork that has to stay re-syncable, so the fetch lives in
`src/lib/loadVibeverse.ts` and hands a plain object across the line.
`net/vibeverse.js` holds and paginates it and imports nothing at all.

**Photographs set `crossOrigin` before `src`.** The panel is a canvas that
becomes a WebGL texture every few frames. Drawing a cross-origin image onto it
without CORS *taints* the canvas, and the next upload throws — which would take
out every display in the ship rather than just the gallery. With `crossOrigin`
set, a server missing the header fails the image *load* instead, so the worst
case is a caption card where a photograph should be.

Every page assumes its table may be empty, because the route can be opened
offline or signed out, and the whole terminal falls back to the ship's own
readout when the hub cannot be reached.

## The passport

`src/lib/passport.ts`, and it is the only thing in this repository that spans
more than one world. Every world stamps it on arrival — one `useWorldStamp`
call per page, nine of them so far — and anything can read every stamp.

It is `localStorage` rather than a table on purpose: a visit record is not
worth a network round trip, an auth check, or a row that fails to write when
somebody is signed out, and the ship has to work with no link at all.

What the ship does with it: names the stamped worlds on the star map, greets a
returning traveller by their record, and tunes the drive — +3.5% thrust, +5.5%
sensors and +4% fold regeneration per world walked in, capped at ten. Play
something else, come back, fly better.

## Bringing it in at all

Upstream is its own site. Bringing it in at all meant changing four structural
things, none of which touch the engine, the shaders or the generator — so a
`git diff` against upstream stays small and re-syncing stays cheap.

**1. Its own copy of Three.** Upstream needs `three@^0.185`; the hub is pinned to
`^0.160` by React Three Fiber and drei, and a bump would take every other world
with it. So the game imports `three-ls` — an npm alias for its own version —
and every `from 'three'` here reads `from 'three-ls'`. Both builds coexist;
only this route pays for the second one, and only when someone flies here.

**2. The stylesheet is scoped.** `ui/style.css` styled the document: `html`,
`body`, `*`, `button`, `.hidden`, `.panel`. Every selector is now prefixed with
`#ls-root`, the wrapper `src/pages/VibeverseExplorer.tsx` renders, and the variables
that lived on `:root` live on the wrapper. Nothing reaches the rest of the hub.

**3. The document became a page.** The boot screen, HUD and archive markup moved
out of `index.html` and into `VibeverseExplorer.tsx` verbatim — same ids, same
classes, because the engine finds its nodes with `getElementById`. React renders
that markup once; the engine keeps writing to it exactly as before. `main.js` is
gone: the page owns the boot sequence and the frame loop now.

**4. It can be left.** Upstream ran until the tab closed, so nothing had a
teardown. `Game.dispose()` (and `Engine`/`Input`/`Audio` beneath it) now drops
the WebGL context, closes the audio context and removes every window listener,
which the route calls on unmount. Without it, three or four visits exhaust the
browser's context limit and the score plays on over the next world.

Assets live in `public/longsilence/models/` rather than `public/models/`, which
the hub already owns; the two paths in the source that referenced them are
absolute now.

Everything else — `tools/`, the capture and judging harnesses, `index.html`,
`wrangler.jsonc` — stayed upstream. `window.__game` is still exposed, so those
harnesses can be pointed at this route.
