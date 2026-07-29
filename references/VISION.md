# Vibeverse — reference vision

Three reference images were supplied as the target for what comes next. The
images themselves belong in this folder as `lobby-ui.png`, `realistic-isles.png`
and `stylized-isles.png`; this document records what is in them so the spec
survives even when the files do not, and so critic agents have a written
standard to score against as well as a picture to diff.

**How to use this folder.** Drop a reference image in, name it after the shot it
targets, and the critic loop opens it beside the matching capture from
`scripts/island-shot.mjs` (or the equivalent per-world harness) and scores the
delta. That is the difference between "does this match a rubric I wrote" and
"does this match the thing you actually want", and it roughly doubles the
ceiling of the iteration loop.

---

## The observation that shapes the plan

Reference 2 and reference 3 **are the same world in two art styles.** Both are
archipelagos of floating islands over a cloud sea, seen at a low warm sun, with
architecture on top and vegetation spilling over the rims. One is rendered
photoreal; one is rendered stylised.

That is a gift, because the expensive part of a world is not its shader — it is
its *spatial truth*: where the islands are, how big, what is on them, how they
connect. `src/island2/geo/islandGeo.ts` already holds that, and it is
renderer-agnostic. So the plan is not "build two worlds from scratch". It is:

> **One archipelago. Two art directions. Plus the front door you arrive through.**

---

## Reference 1 — the lobby / entry screen

Four UI concepts for the same screen, plus a flow strip along the bottom.

**Layout**, consistent across all four concepts:
- Your character stands centred on a **circular platform** in a 3D scene.
- A **horizontal carousel of world cards** floats at eye level behind/around
  them. The focused card is scaled up and ringed with a glow; neighbours are
  smaller and dimmer, receding to the sides. Arrows at the left and right edges.
- Each card carries: art, world **name**, a one-line **description**, and a
  **live player count** ("43 Online").
- A single large **"Enter World"** button, bottom centre, in the concept's
  accent colour.
- Top bar: `Worlds · People · Events · Create`, with a global **"42 Online"**
  pill and the player's avatar at top right.
- Bottom left: **Customize** and **Emotes** buttons.
- A hint line under the button — "Use A/D to explore", "Scroll to explore".
- Every concept is mirrored as a **phone layout** with a bottom tab bar:
  `Worlds · People · Create · Profile`.

**The four moods**, which are really four palettes of the same screen:
1. *Whimsical Path* — warm, inviting, playful. Green forest, dappled light.
2. *Adventurer's Plaza* — bright, energetic. Blue sky, waterfalls, stone plaza.
3. *Storybook Realm* — soft, cosy, imaginative. Purple/pink dusk, blossom.
4. *Nature Hub* — earthy, calming, grounded. Deep green, water, ruins.

**Stated flow:** arrive in lobby → browse worlds → preview world → enter world
→ in-world. **Stated key ideas:** works on mobile and desktop; carousel/swipe
browsing; live player count for social connection; preview + description per
world; a fun transition into the experience.

## Reference 2 — the realistic archipelago

Photoreal floating islands at golden hour, seen across a hazy valley.

- **Architecture is real and specific, not generic fantasy.** A Thai temple
  complex with gold stupas and orange roof tiles. A Bhutanese dzong, white
  walls and dark timber, with prayer flags and terraced fields. A Mediterranean
  villa in warm stone with arched windows, a pool, and bougainvillea. A
  Greco-Roman town with colonnades, domes and terracotta roofs. A small temple
  island hanging high at top left.
- **A snow-capped mountain floats among them**, bare rock and snowfield, at a
  completely different scale to the inhabited isles.
- **Islands are strung together with rope-and-vine bridges** that sag between
  them. Vines and roots hang metres below each island's rim.
- **A real river valley is visible far below** through the haze — so the world
  reads as being *above somewhere*, not floating in abstraction.
- Foreground: a **smooth white rounded robot** with two thin antennae, seen
  from behind, standing among flowers. Soft, friendly, minimal.
- Light: low sun, warm haze, long soft shadows, strong aerial perspective.

## Reference 3 — the stylised archipelago

The same subject, rendered as a bright cel-shaded title screen.

- Pixel-font **"VIBEVERSE"** wordmark; subtitle "What kind of *adventure* do
  you want today?"; strapline "Every builder grows the universe".
- **Saturated blue sky, big soft cumulus**, no haze. Cheerful rather than epic.
- **Low-poly islands with flat-shaded grass** and clean silhouettes; a city
  island of simple blue-white towers, a red pagoda island, a lone-tree island,
  small shards drifting.
- A **zeppelin** in the sky. (Already Vibeverse canon.)
- Foreground: a **yellow blocky robot and a small dog**, seen from behind, on a
  grassy rise.
- Bottom bar: `EXPLORE | BUILD | CREATE | CONNECT`.

---

## The plan this implies

### 1. THE TERMINAL — the new front door
*Reference 3's look, reference 1's interface.*

A small stylised archipelago you actually stand in, which is also the world
picker. Your character on a circular platform; the other worlds orbit as
floating islands you can look at and walk toward; picking one flies you into it.
Live presence, so you see who else is in the lobby and can talk to them — this
is where the Club Penguin social layer belongs, and the backend for it already
exists (`world_rooms` / `world_agents` / `world_messages`, plus the graffiti
wall).

This is the "simple but beautiful" world. Low fidelity is the *style*, not the
budget: flat-shaded does not mean cheap, it means every silhouette, colour and
shadow has to be deliberate because there is no texture detail to hide behind.

### 2. VIBE ISLAND II → the realistic one
*Push the existing world toward reference 2.*

`src/island2` already has the archipelago, the keels, the carved lagoon and the
golden-hour sky. What it needs to become reference 2:
- **Real architecture with cultural specificity** on each island, replacing the
  generic landmark set: the Thai temple, the dzong, the villa, the Roman town.
- **Rope-and-vine bridges** between islands, with proper catenary sag.
- **Hanging vines and roots** below every rim.
- **The floating snow peak** — a bare alpine island at a much larger scale.
- **A valley far below**, visible through gaps in the cloud, so there is a
  *there* down there.
- **Ski and snowboard down the snow peak**, which is the sport idea from the
  brainstorm landing in the world where it costs least: carve physics, powder
  spray and slope grading, with no humanoid animation problem to solve.

### 3. Characters
Both worlds need the same thing and it is the real unlock: the white rounded
robot of reference 2 and the yellow blocky robot of reference 3 are the *same
character* in two styles. Build one character system that can render either.

---

## Scope discipline

Three items, built in this order, each shippable on its own:

1. **The Terminal** — highest visibility, it is what everyone sees first, and it
   carries character select and the social layer.
2. **The snow peak + skiing** on Island II — the most fun per unit of work, and
   it reuses terrain and VFX we already have.
3. **The cultural architecture pass** on Island II — the most work, and the
   thing that most needs the reference image in hand to judge.
