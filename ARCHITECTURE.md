# The shape of the VibeVerse

A map of what is in this repository, how the pieces fit, and which of the
seams are load-bearing versus which are just where two spontaneous projects
happened to meet.

Written 2026-08-01, at 111 commits.

---

## 1. The one-paragraph version

This is **one Vite + React SPA** that serves ~30 destinations off a single
router. Most of those destinations are 3D worlds, and each world is a nearly
self-contained game engine living in its own directory under `src/`. The app
shell — router, nav, identity, radio, Supabase — is thin. The worlds are thick.
Nothing in a world imports anything from another world; the only things that
cross between them are the router, the player's identity, and the passport.

That is a genuinely good architecture for what this is. The pressure it is
under is not structural, it is **inventory**: it got hard to know what exists.

---

## 2. By the numbers

| | |
|---|---|
| TypeScript / JS lines in `src/` | **342,838** across 702 files |
| Route paths in the router | **53** (aliases and redirects included) |
| Worlds in the registry | 32 (24 playable, 8 app surfaces) |
| Game engines with their own directory | 10 |
| Supabase edge functions | 16 |
| Database migrations | 16 |
| Test files / tests | 20 / 253 |
| Production build | 59 s, 6.8 MB entry chunk (2.07 MB gzip) |
| `dist/` on disk | 283 MB (mostly `.glb` and world art) |
| Commits | 111, all since 2026-07-09 |

### Where the code actually is

| Directory | Lines | What it is |
|---|---:|---|
| `src/sf` | 109,792 | **San Francisco: Free Fall** — real-geometry SF, the largest thing here by 2×. Has its own `ai/`, `physics/`, `weapons/`, `vehicles/`, `postfx/`, `sky/`, and an `ART_DIRECTION.md`. |
| `src/kart` | 50,721 | **Vibe Kart** — arcade racer. Own track baker, AI drivers, audio engine. |
| `src/longsilence` | 41,277 | **The Vibeverse** (ship + galaxy). A *vendored fork* of a standalone game — see `src/longsilence/README.md`. |
| `src/components` | 36,986 | App shell + Vibe City's guts + 49 shadcn/ui primitives. |
| `src/pages` | 28,172 | Route components. Two are enormous (`City.tsx` 7.4k, `Unit7Playground.tsx` 5.3k); most are thin. |
| `src/palmas` | 25,384 | **San Palmas** — tropical FPS. |
| `src/golf` | 22,654 | **Vibe Golf** — 63 holes of physics golf. |
| `src/integrations` | 5,583 | Generated Supabase types. |
| `src/seafair` | 5,515 | **Seafair 2117** — module/entity system, the most "engine-shaped" of the small ones. |
| `src/game` | 3,505 | **Genesis Bloom** evolution sim (R3F). |
| `src/island` | 3,464 | **Island Explorer** (R3F). |
| `src/island2` | 2,471 | **Vibe Island II**. |
| `src/terminal` | 1,195 | **The Terminal** — the 3D lobby. |
| `src/lib`, `src/hooks` | 3,442 | The genuinely shared code. Small on purpose. |

The interesting number is that last one. **Under 1% of this codebase is shared
between worlds.** That is not an accident and it should stay that way.

---

## 3. How a world plugs in

Every recent world follows the same five-part contract:

```
src/pages/Seafair.tsx        thin page: menus, a container, teardown
  └─ src/seafair/            everything that moves
src/App.tsx                  <Route path="/seafair">, lazy if it is heavy
src/worlds/registry.ts       one entry → nav, picker, /game, passport, hub
src/assets/worlds/*.jpg      card art, captured from the running world
```

Plus one rule with teeth: **dispose on unmount.** Browsers cap live WebGL
contexts, so a world that leaks one breaks the *next* world a visitor opens.
That is the single most expensive bug class in a repo shaped like this one,
because the symptom shows up in innocent code.

### Two engine families

Worlds here are written in one of two styles, and it is worth knowing which
you are in before you start editing:

- **Imperative Three.js** — `boot.ts` builds the scene, `engine/` runs a
  fixed-step loop, `ui/` is a thin React layer reading engine state.
  → `sf`, `kart`, `palmas`, `golf`, `island2`, `seafair`, `terminal`
- **react-three-fiber** — the scene graph *is* React.
  → `island`, `game` (Genesis Bloom); the older `/space` and `/garden` pages use
    raw Three.js in a `useEffect` instead, which is a third style and the one
    new code should not copy.

Neither is wrong. The imperative style won for anything with a frame budget,
because a 60 fps physics loop does not want a reconciler in it. R3F won for
the calmer, more declarative worlds. New heavy worlds should follow the
imperative pattern; `src/palmas` is the cleanest small example to copy.

### Vendoring someone else's game

`src/longsilence` is a fork of a standalone site, kept re-syncable. Its README
documents the four changes that turned it into a route and why each one was
necessary. If you vendor another game, read that first — it is the cheapest
half hour in the repo.

---

## 4. What actually spans worlds

Only four things, and each is deliberately tiny:

1. **The router** (`src/App.tsx`) — 53 paths. Aliases exist because links
   were shared before names settled (`/fps` = `/san-palmas`, `/free-fall` =
   `/sf`, `/long-silence` = `/vibeverse`).
2. **Identity** (`use-vibe-identity`, `use-active-character`) — the character
   you pick follows you between worlds via `localStorage`.
3. **The passport** (`src/lib/passport.ts`) — `localStorage`, no network, no
   auth. A world stamps it on arrival; every other world can read every stamp.
   Deliberately not in Supabase: a visit record is not worth a round trip, and
   the ship has to work offline.
4. **The registry** (`src/worlds/registry.ts`) — see below.

Supabase sits *beside* the worlds rather than under them: 16 edge functions
for Vibey's chat, the nightly newspaper, the economy, agent replies. Worlds
that never call it (the ship, the kart racer, golf) work fully offline, and
that is a property worth protecting.

---

## 5. The registry, and the problem it fixed

Until recently, "the worlds" existed as **six hand-maintained lists**:

| List | Entries |
|---|---|
| `WorldPicker.tsx` | 23 |
| `GlobalNav.tsx` | 24 |
| `HubV2.tsx` | 19 |
| `terminal/geo/terminalGeo.ts` | 10 |
| `lib/passport.ts` | 11 |
| `longsilence/world/vibeworlds.js` | 5 |

They disagreed, in ways that were invisible until someone went looking:

- **Vibe Kart** appeared in exactly one of them.
- **Seafair** and **The Vibeverse** were missing from the landing page.
- **Vibe Golf** was missing from the nav.
- The **"Healdsburg Village"** card pointed at `/`, which stopped being the
  village the day the hub took that route. Clicking it reloaded the page you
  were already on.

Now there is one list — `src/worlds/registry.ts` — and everything else is a
view of it:

```
src/worlds/registry.ts  ──┬─→ GlobalNav        (nav: true)
   (data only, no React)  ├─→ WorldPicker + /worlds
                          ├─→ /game            (the flat index)
                          ├─→ HubV2            (worlds with card art)
                          ├─→ App.tsx          (CHROMELESS_ROUTES)
                          └─→ lib/passport.ts  (passport: true)
src/worlds/art.ts         ──→ card art, keyed by world key
```

`registry.ts` imports nothing — no React, no three, no images — because the
passport and the vendored ship both read it and neither should drag a megabyte
of JPEGs into its chunk. Art lives next door in `art.ts`.

`src/test/worlds-registry.test.ts` reads the actual router, the actual pages
and the actual Terminal gates, and fails if the registry disagrees with any of
them. A registry that can drift is just a seventh list.

**The Terminal's gates and the ship's star chart still hold their own data** —
island geometry, chart coordinates, motifs — because that data is genuinely
theirs. But their *keys and routes* are now checked against the registry, so
they can no longer point somewhere that does not exist.

---

## 6. The two front doors

There are deliberately two ways in, and they do different jobs:

- **`/` — HubV2.** A 3D carousel: Vibey on an asteroid, worlds as textured
  spheres. This is the brand moment. It costs a WebGL context and several
  seconds.
- **`/game` — the index.** Flat, fast, linkable, phone-friendly. Every world
  and game as a card, filterable by kind, searchable. This is the page you
  send someone.

The 🌐 chip in the nav points at `/game`, and the installed PWA opens there.

`/worlds` is the same content as an overlay, and `/terminal` is the same idea
rendered *in* 3D. Three surfaces, one list.

---

## 7. Honest structural debt

Ranked by what it actually costs:

1. **The entry chunk is 6.8 MB (2.07 MB gzip).** Everything not explicitly
   lazy — City at 7.4k lines, Unit7Playground at 5.3k, MapView at 3.4k,
   mapbox-gl, three, every world art JPEG — is in the bundle you download to
   look at the hub. Only Seafair, the Vibeverse, and Vibe Kart are lazy. Making
   every route `lazy()` is the single highest-leverage change available, and it
   is mechanical.
2. **Two copies of three.js.** `three@0.160` for the app, plus
   `three-ls` (an alias for `three@0.185`) for the vendored ship. That is the
   price of keeping `longsilence` re-syncable, and it is probably worth paying —
   but it should be a decision, not a surprise.
3. **`npm install` fails on peer deps** and needs `--legacy-peer-deps`; the
   repo is really a Bun project (`bun.lock`). Fine, but undocumented until now.
4. **`City.tsx` is 7,360 lines.** It is four worlds in a trench coat (city,
   island, ski, moon, star, all via `?spawn=`). It works, and splitting it is a
   real project, not a cleanup.
5. **`README.md` and `WORLDBUILDING.md` are Edge-Esmeralda-era.** The village
   map is now one destination out of thirty, not the subject.
6. **One flaky test.** A muzzle-direction assertion in `src/sf/weapons` fails
   roughly one run in twenty. Pre-existing.

None of these are emergencies. Item 1 is the one a visitor can feel.

---

## 8. If you are adding a world tomorrow

1. `src/<world>/` for everything that moves; `src/pages/<World>.tsx` for the
   shell.
2. `lazy()` it in `App.tsx` if it is over a few hundred kB.
3. One entry in `src/worlds/registry.ts`. Set `chromeless: true` if it owns the
   viewport, `passport: true` if you also add `useWorldStamp` to the page.
4. `node scripts/route-shot.mjs /<route> src/assets/worlds/<key>.jpg`, then add
   it to `src/worlds/art.ts`. If the capture is a broken frame, ship no art —
   misleading card art is worse than none.
5. Dispose everything on unmount.
6. `npm run build` **and** open the route in a real browser. A world that
   builds and renders a black screen is a broken demo, and the build will not
   tell you.
