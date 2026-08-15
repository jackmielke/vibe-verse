# Performance

Forty-odd worlds, ninety-odd render surfaces, one three.js pin. This is what
they actually cost, measured rather than guessed, and what to do about it in
what order.

Everything below was produced by `npm run perf` (`scripts/route-perf.mjs`) and
the two throwaway harnesses described at the bottom. Re-run it before and after
anything you change here; the point of writing the numbers down is to be able
to tell whether they moved.

## How to read the numbers

The container that produced these has no GPU — Chromium falls back to
SwiftShader and rasterises on the CPU. That splits the measurements in two:

- **Draw calls, triangles, shader programs, texture bytes, live contexts and JS
  heap are exact.** They are counts of what the page asked the driver to do,
  and they are identical on a real GPU. Optimise against these.
- **fps and p95 are relative only.** SwiftShader is orders of magnitude slower
  at fill. Use them to rank routes against each other and a commit against its
  parent, never to predict what a MacBook will do.

## What the worlds cost

Measured at 1280×800, DPR 1, sampled for six seconds after a nine-second settle
so that shader compilation and asset loading are not averaged into the frame
time.

| route | draws/frame | triangles/frame | programs | texture MB | contexts | heap MB |
|---|---|---|---|---|---|---|
| `/city` | 299 | **3,267,758** | 32 | 16.0 | 2 | 95.5 |
| `/sf` | 197 | 2,037,814 | 27 | 9.0 | 1 | **270.5** |
| `/kart` | **453** | 918,713 | **78** | **39.9** | 1 | 107.0 |
| `/royale` | — | — | 60 | 42.4 | 1 | 211.3 |
| `/starfleet` | 48 | 49,556 | 19 | 9.1 | 1 | 35.2 |
| `/trek` | 110 | 9,444 | 8 | 8.7 | 1 | 38.8 |

`/royale`, `/golf`, `/palmas` and `/seafair` sat on a title screen for the whole
sample and never drew — their programs and textures are real, their draw counts
are missing. The profiler clicks once and cannot get past a menu that wants a
specific button. That is a gap in the tool, not a clean bill of health.

The front door, against a production build: **4.70 MB across 38 requests**.
882 KB entry chunk, 652 KB of three.js, 564 KB `iridescent-arc.glb`, and about
1.5 MB of PNG portraits.

## The five findings, in the order worth fixing them

### 1. Resolution is the biggest lever, and almost nothing adapts it

Twenty-five of the twenty-nine render surfaces hard-code
`Math.min(window.devicePixelRatio, 2)`. On a Retina MacBook that is DPR 2 —
four times the pixels of DPR 1, every frame, forever.

Measured on `/city`: identical geometry (3.27 M triangles, ~300 draws both
times), **p95 frame time 8,695 ms at DPR 1 and 19,555 ms at DPR 2**. A 2.25×
cost for pixels nobody asked for. That is the single largest number in this
document and it is available for free.

It is worse than it looks, because of how the tier is chosen. There are **six
separate copies of a `detectQuality()` function** — `src/sf/config.ts`,
`src/island2/config.ts`, `src/seafair/core/Settings.ts`,
`src/royale/engine/core.ts`, `src/kart/engine/core.ts`,
`src/palmas/engine/core.ts`, `src/golf/engine/core.ts` — and they disagree:

| world | what a 10-core MacBook gets |
|---|---|
| `/kart`, `/seafair` | **ultra** |
| `/royale`, `/palmas`, `/golf` | high |
| `/sf`, `/island2` | high (their `ultra` needs `mem >= 16`, which cannot happen — see below) |

All six read `navigator.deviceMemory` and `navigator.hardwareConcurrency`.
Neither can see the GPU. `deviceMemory` is **not implemented in Safari or
Firefox at all** (so every branch falls to the `?? 8` default) and in Chrome it
is **capped at 8** for fingerprinting reasons — which is why the `mem >= 16`
branch in `/sf` and `/island2` is dead code that can never be taken.

So the machine that struggles and the machine that does not receive the same
settings, and — with one exception — nothing ever checks whether the guess was
right.

**The exception is the fix.** `src/seafair/core/Engine.ts` already has it: an
`adapt()` method that keeps a 90-frame window, takes the p90, and walks
`renderScale` between 0.55 and 1.0 against a 58 fps target. Forty lines, already
written, already shipping, and confined to one world.

> **Do this first.** Lift `adapt()` into a shared module and give every engine
> a `renderScale`. A device guess only has to be *approximately* right if
> something measures the result a second later; without that, it has to be right
> first time, which none of these can be.

### 2. WebGL contexts leak across navigation

Every one of the twenty-nine renderers calls `renderer.dispose()` on unmount,
which is better than expected. But in three r160 `dispose()` does **not** release
the GL context — it drops three's own caches and leaves the context to the
garbage collector. `renderer.forceContextLoss()` is what releases it, and
**twenty-five of the twenty-nine never call it.**

Navigating world → hub → world in a single page, no reloads:

```
after /city            created=  3  lost=  0  live=  3
after /trek            created=  5  lost=  0  live=  5
after /starfleet       created=  7  lost=  1  live=  6
after /museum          created=  9  lost=  1  live=  8
after /memory-garden   created= 10  lost=  1  live=  9
after /gallery         created= 13  lost=  1  live= 12
```

Six worlds, twelve live contexts, one released. Browsers cap live contexts
around sixteen, and when you cross it the browser starts killing the *oldest*
context — so the tab that breaks is not the world you just opened. This is
exactly the failure CLAUDE.md warns about in "Adding a world", now with a
number against it.

`route-smoke.mjs` cannot see this, because it opens a fresh page per route. A
real visitor does not.

**Fix:** `renderer.forceContextLoss()` after `dispose()`, and walk the scene
disposing geometries, materials and textures. Mechanical, twenty-five files,
and it wants a test that navigates rather than reloads.

### 3. The model pipeline guessed from filenames — fixed

`glb-optimize.mjs` decided whether a model was rigged with a regex over its
name:

```js
f.includes("/characters/") || /vibey|alien|astronaut|robot/i.test(...)
```

`floating-astronaut.glb` matched `/astronaut/`, so it skipped decimation and
shipped at **702,760 triangles and 15.9 MB** — for a prop that spins in the
distance with no skin and not one animation channel. It is the
`floating-island.glb` story from the top of that script, repeated, by the
shortcut the script took to avoid reading the files.

Reading all 246 models: the guess was wrong about exactly three of them, and
those three held **1.13 M of the 1.82 M triangles in the folder**. Nothing
skinned was wrongly decimated, so correcting it could only help.

Now fixed — `riggedFlags()` parses the GLB header chunk and looks for `skins`
and `animations`:

| file | before | after |
|---|---|---|
| `floating-astronaut.glb` | 15.93 MB / 702,760 tris | **1.03 MB / 30,423 tris** |
| `vibey.glb` | 5.03 MB / 215,129 tris | 1.53 MB / ~75,000 tris |
| `expressive-vibey.glb` | 5.03 MB | 1.53 MB |

**26.0 MB → 4.1 MB, and `glb-verify.mjs` reports 247 files checked, nothing
lost.** `dist/` went from 120 MB to 98 MB on the back of three files.

Vibey needed a second mechanism, and it is the reason to keep taking
`glb-compare.mjs` seriously. At the default error budget the mascot came out at
13,559 triangles with a visibly faceted shoulder and a dented head — a 91%
saving that you would absolutely have shipped on the strength of the number.
There is now a `CLOSE_UP` set in the script for static models that are looked at
closely; they get a tenth of the error budget and land at a third of the
original rather than a twentieth.

> Two models are shipped twice — `src/assets/glb/vibey.glb` and
> `public/models/expressive-vibey.glb` are byte-identical. Worth collapsing.

### 4. Standalone images never went through any pipeline

Every texture *inside* a `.glb` is WebP, capped at 1024, because
`glb-optimize.mjs` does that. Every image *outside* one is whatever it was
exported as, and most of them are PNG.

| | now | as WebP |
|---|---|---|
| 63 character portraits | 5.47 MB | **0.99 MB** (−82%) |
| `world-builder-bg.png` | 2.74 MB | 0.20 MB |
| `edge-esmeralda-logo.png` | 2.56 MB | 0.77 MB |
| `edge-app-icon-bg.png` | 0.81 MB | 0.09 MB |

About **9.5 MB**, and the portraits are on the front-door path. The portraits
have transparent backgrounds, which is the usual reason to keep a PNG — WebP
carries alpha, so it is not a reason here.

Not done: it means renaming files and editing every import, which is a wide,
boring diff that deserves its own commit rather than riding along with an audit.

### 5. Triangles and draw calls in the heavy worlds

`/city` draws **3.27 M triangles per frame**. One shadow-casting directional
light roughly doubles the geometry cost, so call it 1.6 M of scene re-rendered
into the shadow map and again into the frame. `/kart` issues **453 draw calls**
and links **78 shader programs**; `/royale` uploads **42 MB of texture**.

Worth attacking, in this order:

- **Shadow scope before shadow resolution.** A tightly-scoped shadow camera is
  worth more than a bigger map. `/city` covers a 360 m district from one
  directional light.
- **Frustum and distance culling.** 3.27 M triangles per frame for a district
  you see one street of is mostly geometry behind the camera.
- **Merge and instance.** `InstancedMesh` already appears in 73 files, so the
  idea is understood; `src/components/city/cardboardIsland.ts` alone constructs
  320 separate `THREE.Mesh` instances.
- **Heap.** `/sf` at 270 MB and `/royale` at 211 MB is GC pressure, which shows
  up as periodic hitching rather than a low average. The allocation-heavy files
  are listed by `rg 'new THREE.(Vector3|Quaternion|Matrix4)'` — the worst are
  `palmas/world/landmarks.ts`, `seafair/modules/10-vegetation.ts` and
  `royale/play/match.ts`. Scratch objects hoisted out of the frame loop are the
  standard fix.

## If this becomes a project

The shape it wants, roughly in dependency order:

1. **One `src/lib/quality.ts`.** One `detectQuality()`, one tier table, one
   place to change the DPR cap. Deletes six copies that already disagree. This
   is the registry argument from CLAUDE.md — "do not start a seventh list" —
   applied to quality settings, and there are already seven.
2. **One `useRenderLoop` / shared engine base** carrying seafair's `adapt()`,
   the fixed-step accumulator, the resize handler, and a teardown that actually
   calls `forceContextLoss()`. Most of the twenty-nine surfaces re-implement all
   four, slightly differently.
3. **A perf budget in CI.** `route-perf.mjs` writes JSON; failing a PR that puts
   `/city` over 3.5 M triangles is a two-line check, and it is the only thing
   that will stop this drifting back.
4. **A settings UI that reaches every world**, so a player on a weak machine can
   say so once instead of per world. Seafair has one; it is seafair's.

Nothing above requires moving the three.js pin, and none of it should be
attempted alongside moving it.

## Tools

- `npm run perf` — `scripts/route-perf.mjs`. Per-route draws, triangles,
  programs, texture bytes, contexts, heap. `PERF_DPR=2` emulates a Retina
  display; `PERF_JSON=out.json` writes machine-readable output.
- `scripts/glb-verify.mjs` — the model safety net. Run it after any pipeline
  change; it names any clip, channel, skin, mesh or morph target that vanished.
- `scripts/glb-compare.mjs` — two renders, same camera, side by side. The Vibey
  result above is why this is not optional.
