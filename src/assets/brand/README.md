# Brand assets

The marks that are *the Vibeverse*, as opposed to art belonging to any one
world. World card art lives in `../worlds/` and is keyed off the registry; this
folder is the identity.

## What belongs here

| File | What it is | Where it is used |
|---|---|---|
| `vibe-wink-white.svg` | The wink, flat white, transparent | Anywhere on a coloured or photographic ground: nav, favicons, og:image, print, a sticker |
| `vibe-wink-glass.png` | The wink, iridescent glass render | The hero moments — `/join`, the `/game` lockup, the auth dialog |

Two files, because they are not the same asset at different sizes — they are
different answers to "what is behind this mark". The glass render is gorgeous
and it needs a dark, quiet ground to be gorgeous on; the flat white one is what
you reach for when the ground is already busy, or when the mark has to be
16 px, or when it needs to be one colour.

## The third mark

`VibeArc` (`src/components/VibeArc.tsx`) is the iridescent arch — a real GLB
rendered live with an environment map, not an image, which is why it can spin
and react to a click. It already carries the identity in the auth dialog, the
hub, the arcade and Vibe City. It is part of the same family and is deliberately
*not* a file in here: it is geometry, and it belongs with the code that renders
it.

## Rules

- **Never redraw the wink.** If a surface needs the mark at a size or on a
  ground these two files do not cover, add a third file here — do not
  approximate it in SVG paths inside a component. A hand-traced logo is a
  slightly-wrong logo, and slightly-wrong is worse than absent.
- Reference them through `src/lib/brand.ts` rather than importing the paths
  directly, so there is one place to look when a file is replaced.
- The glass render is a raster. Export it at 2× the largest size it is used at
  (currently 512 px, so 1024 px) and keep the transparency.
