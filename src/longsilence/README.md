# THE LONG SILENCE — vendored

Anshu Chimala's procedural space-exploration game, from
[github.com/achimala/TheLongSilence](https://github.com/achimala/TheLongSilence)
(MIT — the licence travels with the code, in `LICENSE` beside this file).

Upstream is its own site. Bringing it into the vibeverse meant changing four
things and nothing else; the engine, the shaders, the generator and the game
itself are untouched, so a future `git diff` against upstream is small and
re-syncing stays cheap.

**1. Its own copy of Three.** Upstream needs `three@^0.185`; the hub is pinned to
`^0.160` by React Three Fiber and drei, and a bump would take every other world
with it. So the game imports `three-ls` — an npm alias for its own version —
and every `from 'three'` here reads `from 'three-ls'`. Both builds coexist;
only this route pays for the second one, and only when someone flies here.

**2. The stylesheet is scoped.** `ui/style.css` styled the document: `html`,
`body`, `*`, `button`, `.hidden`, `.panel`. Every selector is now prefixed with
`#ls-root`, the wrapper `src/pages/LongSilence.tsx` renders, and the variables
that lived on `:root` live on the wrapper. Nothing reaches the rest of the hub.

**3. The document became a page.** The boot screen, HUD and archive markup moved
out of `index.html` and into `LongSilence.tsx` verbatim — same ids, same
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
harnesses can be pointed at this route when the remixing starts.
