# Trader Joe's Galaxy — new world + game brainstorm

## What I'll build (this turn, if you approve)

A brand-new destination called **TJ's Galaxy** (working title) that slots into the existing fast-travel cycle right next to Mars. Same character, same physics, same jetpack/parkour/fall-damage rules — just a different "biome" stacked with Trader Joe's-themed cardboard buildings in the style of the reference photo (kraft cardboard, vines, twinkle lights, "GOOD FOOD GOOD VIBES" neon, banana crates, hibiscus).

### Layout
A small floating archipelago of 5 mini-islets in the sky, each holding a different Trader Joe's outpost, connected by short cardboard bridges:

```
        [ FROZEN AISLE ]            <- icy-blue cardboard, frosty signs
              |
[ FEARLESS FLYER ]---[ TJ'S PLAZA ]---[ SNACK SHACK ]
                          |
                    [ BANANA STAND ]   <- giant banana crate, 19¢ sign
```

- **TJ's Plaza** (center): big "TRADER JOE'S — ISLAND OUTPOST 0002" sign, hula-girl bobblehead, "TODAY'S FINDS" board listing rotating items, solar panel roof, string lights, vine overgrowth.
- **Fearless Flyer**: hanging wooden sign, newsprint flyer wall you can read up close.
- **Frozen Aisle**: pale-blue tinted cardboard, "EVERYTHING BUT THE BAGEL" frost-neon, foggy floor.
- **Snack Shack**: dark-chocolate / almond-butter palette, stacked snack-crate stalls.
- **Banana Stand**: oversized "ORGANIC BANANAS" crate as a building.

Lit by warm sunset lighting (matching the reference image) — slightly different sky tint than Cardboard Island so it reads as a separate world.

### Fast-travel integration
- Cycle becomes: Plaza → Cardboard Island → Moon → Mars → **TJ's Galaxy** → Plaza.
- HUD label updates to show "🛒 TJ's Galaxy" as the next destination.
- New `?spawn=tjs` URL deep-link.
- Lands you on TJ's Plaza islet, jetpack stays equipped, all collisions/fall-damage behave as today.

### Files touched
- New: `src/components/city/tradersGalaxy.ts` (builder, mirrors `cardboardIsland.ts` patterns).
- `src/pages/City.tsx`: register world, add spawn ref, extend travel cycle, HUD label.

## Game brainstorm (no code yet — pick a favorite and I'll plan it next)

1. **Fearless Flyer Scavenger Hunt** — a rotating shopping list appears (Mango, Coconut Water, Dark Chocolate, Everything But The Bagel…). Items spawn as glowing pickups hidden across the islets. Grab them all before the timer ends → leaderboard time. Pure speedrun.
2. **Cart Run** — you push a runaway cardboard shopping cart down a winding ramp between islets, dodging banana peels and stacking items into it for combo points. Endless-runner energy.
3. **Restock Rush** — co-op/solo: trucks drop pallets at the plaza, you jetpack them to the right outpost (frozen → Frozen Aisle, snacks → Snack Shack). Wrong drop = lose a heart. Survive 5 waves.
4. **Hidden Hibiscus** — daily easter-egg hunt: one tiny red hibiscus is tucked somewhere new each day; first finder gets a cosmetic (a TJ's paper-bag hat that joins the Holo Sticker Hat).
5. **Two-Buck Chuck Bowling** — knock over stacked wine-box pins with a rolling banana from the top of the ramp. Mini-arcade, fits in a modal like Esmeralda Jump.
6. **Aisle Parkour Time Trial** — checkpoint course weaving through the 5 outposts, leveraging existing wall-jump + jetpack. Fastest lap saved locally.

My pick for best fit with current engine: **#1 Fearless Flyer Scavenger Hunt** (reuses pickup + HUD timer patterns from Mars; minimal new systems).

## Technical notes

- New world placed at e.g. `(TJS_X = -600, TJS_Z = -400, TJS_TOP = 90)` — far from Cardboard Island so you don't see both at once, similar pattern to Mars.
- Reuses `cardboardTexture()` / `signTexture()` helpers exported from `cardboardIsland.ts` to keep the aesthetic identical; add a `frostedCardboardMat` variant for the Frozen Aisle.
- Each islet = small cylinder + collision box pushed into the shared `boxes` array, identical to existing buildings.
- No physics, jetpack, character, multiplayer, or networking changes.

## What I need from you
- Approve the world build as described, and
- Tell me which game idea (1–6) to spec out next (or pick a mash-up).
