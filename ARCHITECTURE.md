# The shape of the VibeVerse

A map of what is in this repository, how the pieces fit, and which of the
seams are load-bearing versus which are just where two spontaneous projects
happened to meet.

Written 2026-08-01 at 111 commits; economy and freshness sections added 2026-08-07.

---

## 1. The one-paragraph version

This is **one Vite + React SPA** that serves ~45 destinations off a single
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
| TypeScript / JS lines in `src/` | **506,333** across 923 files |
| Route paths in the router | **57** (aliases and redirects included) |
| Worlds in the registry | 45 (36 playable, 9 app surfaces) |
| Game engines with their own directory | 12 |
| Supabase edge functions | 18 |
| Database migrations | 20 |
| Test files / tests | 26 / 826 |
| Production build | ~75 s, 7.0 MB entry chunk (2.11 MB gzip) |
| `dist/` on disk | ~285 MB (mostly `.glb` and world art) |
| Commits | 247, all since 2026-07-09 |

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

Six things now, and the first four are still deliberately tiny:

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
5. **The currency** (`src/lib/vibecoin.ts`) — one balance, spendable in any
   world that wants to charge for something. The fifth thing to span worlds and
   the first that can be *lost*, which is why it is the only one of the six
   that refuses to trust the browser. See §7.
6. **The wardrobe** (`src/lib/wardrobe.ts`) — hats, flames and jetpacks, bought
   once and worn wherever a world renders a character. Server-held, so it
   survives a cleared cache and follows you to a phone.

Supabase sits *beside* the worlds rather than under them: ~17 edge functions
for Vibey's chat, the nightly newspaper, the economy, the pot, agent replies.
Worlds that never call it (the ship, the kart racer, golf) work fully offline,
and that is a property worth protecting.

There is a seventh thing that spans worlds but is not code you call: **the
dates on every card** come from `src/worlds/updated.ts`, generated by
`npm run stamp` from the git history of each world's `source` path. It is a
build artifact rather than a runtime lookup because the browser has no git and
a card should not wait on GitHub to render a date.

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

## 7. The economy, and the one rule that holds it up

Vibecoin (`✦`) is the newest cross-world layer and the only one where being
wrong costs somebody something. Full detail is in `docs/VIBECOIN.md`; the
architecture is four sentences.

**There are two Vibecoins and they must not be confused.** The *ledger* is rows
in `vibe_balances` / `vibe_ledger` — play money, everyone has 100 of it the
moment they arrive, signed in or not. *$VIBE* is a real ERC-20 on Base. The app
reads the token and never sends a transaction; the two touch only through a
manual, reviewed distribution. Every "how much is this worth" question is about
the second, and every gameplay balance is the first.

**Every write goes through an edge function.** `vibe_balances` has RLS on and
the browser has no path to it — `vibe-economy` and `vibe-rounds` hold the
service-role key. A cheat therefore has to beat the server's clamps rather than
a client-side `if`. Scores are clamped to what a perfect run can produce before
any payout curve runs, payouts are capped per day, and a play settles exactly
once against a real debit.

**Prices and payouts are written twice on purpose**, once in the client so a
machine can print an honest paytable before you pay, and once in the edge
function which is the authority. `arcade.test.ts`, `wardrobe.test.ts` and
`orbit.test.ts` each parse the deployed function's *source* and assert the two
copies agree — because two numbers that pay people is exactly the pair that
drifts, and the failure is silent in the worst direction.

**Take the lock before the money moves.** Every flow that could double-spend
does its unique-index or primary-key insert *first* and debits second, so a race
loses before anything is paid: `vibe_round_entries` (round_id, owner_ref),
`vibe_invite_claims` (code, owner_ref), `vibe_guest_claims` (guest_ref), and the
arcade's play id, which is the ledger row of its own debit.

### What charges, and what pays

| Surface | Takes | Gives back |
|---|---|---|
| `/arcade` | 6–10 per play | a paytable, capped at 400/day |
| `/shop` | 25–400, once per item | a hat you keep, on any device |
| `/orbit` | a round's buy-in | the whole pot, to the best run |
| `/join/:code` | nothing | an invite grant, once per person |

---

## 8. Honest structural debt

Ranked by what it actually costs:

1. ~~**The entry chunk is 6.8 MB (2.07 MB gzip).**~~ **Done — it is 832 kB
   (256 kB gzip).** See §10.
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

None of these are emergencies, and the one a visitor could feel is fixed.

---

## 9. If you are adding a world tomorrow

1. `src/<world>/` for everything that moves; `src/pages/<World>.tsx` for the
   shell.
2. `lazy()` it in `App.tsx`. Always — see §10.
3. One entry in `src/worlds/registry.ts`. Set `chromeless: true` if it owns the
   viewport, `passport: true` if you also add `useWorldStamp` to the page.
4. `node scripts/route-shot.mjs /<route> src/assets/worlds/<key>.jpg`, then add
   it to `src/worlds/art.ts`. If the capture is a broken frame, ship no art —
   misleading card art is worse than none.
5. Dispose everything on unmount.
6. `npm run build` **and** open the route in a real browser. A world that
   builds and renders a black screen is a broken demo, and the build will not
   tell you. `node scripts/route-smoke.mjs /<route>` is the cheap version of
   that check; it opens the route and reports whether anything appeared.

---

## 10. What the first page weighs, and how it stays that way

Fixed 2026-08-09. The numbers, from `npm run build`:

| | before | after |
|---|---:|---:|
| entry chunk | 7,361 kB | **832 kB** |
| entry chunk, gzipped | 2,256 kB | **256 kB** |
| modules in it | 1,654 | 574 |

Nothing was deleted and no world got smaller. Three things moved:

1. **Every route in `App.tsx` is `lazy()`.** Thirty of them were not, and the
   sum of "this one is small enough" was San Palmas, Vibe Golf, Vibe City,
   Unit7, Island Explorer, Globetrotter and mapbox-gl in the bundle you
   download to look at a grid of cards. The rule is now unconditional, with two
   deliberate exceptions — the landing grid and the 404, the two pages that
   must not wait on a second round trip.
2. **The nav's coin chip stopped reaching through heavy neighbours.** It wanted
   two functions: `readPayoutAddress`, which it imported from
   `VibeWalletConnect` and so brought the whole Base Account SDK with it, and
   `shortAddress`, four lines of string slicing that lived in `vibe-wallet.ts`
   next to a viem public client. Both now live somewhere weightless
   (`lib/walletBook.ts` and `lib/address.ts`), re-exported from where they were
   so no call site broke. That was ~1.1 MB.
3. **The login dialog's 3D arch is lazy.** `VibeAuthDialog` hangs off the nav's
   log in button, and it opens with a decorative WebGL arch — which put all
   1.4 MB of three.js in the entry chunk of an app where most pages have no
   3D on them at all. Radix only mounts dialog content when the dialog opens,
   so the import now fires on the tap that opens it.

Points 2 and 3 are the same bug twice, and it is the one worth watching for:
**a shared module is only as light as its heaviest import.** Nothing about
`VibeCoinChip` or a login form suggests three.js or a chain client, which is
exactly why nobody noticed for months. When you add an import to anything the
global nav renders, check what comes with it.

`node scripts/route-smoke.mjs` opens every route in a real browser and reports
whether anything rendered. It exists because lazy routes move failures from
build time to click time: a bad import in a world used to break the build, and
now it breaks that world only, for whoever clicks it first.
