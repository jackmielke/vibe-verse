# SAN FRANCISCO: FREE FALL — Art Direction Bible

The single reference every subsystem and every critic judges against. If a change
disagrees with this document, the change is wrong or this document needs updating
first — not silently diverged from.

---

## 1. The bar we are actually clearing

The stated target is "as good as the most recent Just Cause games." It is worth being
precise about what that means, because Just Cause 4 is not uniformly excellent and
pretending otherwise leads to copying its mistakes.

**What Just Cause does better than almost anything else, and we must match:**

- **Draw distance.** You can see across the entire map. Standing on a peak and seeing
  a coastline 8 km away is the series' signature, and it is what sells the scale of the
  traversal. Our clipmap terrain, LOD chain and impostor tier exist for this reason.
- **Explosions and destruction.** The explosions are layered, physical, and chained. A
  fuel tank does not "play an explosion" — it lights, shocks, throws debris, burns, and
  sets off its neighbours.
- **Extreme weather as spectacle.** JC4's tornado and storm systems are the best thing
  in the game. Weather is not garnish; it is a headline feature.
- **Traversal readability.** However chaotic the scene, you always know where you are,
  where the ground is, and where you are going.

**Where Just Cause 4 is genuinely weak, per contemporaneous technical analysis
(Digital Foundry, DSOGaming): textures, flat lighting in many conditions, and — called
out specifically — the water.** Those are also, not coincidentally, the three things a
browser renderer can actually win on, because they are art and shader problems rather
than content-volume problems.

**So the strategy is explicit:**

> Match Just Cause on scale, destruction and weather.
> **Beat** it on material quality, lighting, atmosphere and water.

A blind side-by-side is winnable, but only on those axes. We will never win on asset
volume, animation quality, or character fidelity — a hundred-person art team over four
years is not a thing to be out-worked. So we do not fight there: we lean into a real
city, real light, real fog, and real water, and we make every surface earn its pixels.

---

## 2. Palette

Just Cause 3 built its look on a single strong complementary axis: **golden ochre against
teal blue.** It is the reason those screenshots read instantly. We need our own axis,
and San Francisco hands us one that is both true to the place and just as strong:

> **Warm dry gold and terracotta against cold marine grey-blue.**

- **Warm side:** the dry summer-gold hills, terracotta and stucco, the International
  Orange of the Golden Gate, low sun on glass, sodium streetlight, Chinatown red and gold.
- **Cold side:** the marine layer, the bay, fog-shadowed concrete, blue-hour sky,
  north-light on white Victorians.

Every hero shot should have both. A shot that is entirely warm reads as generic sunset;
a shot that is entirely cold reads as drab. The fog is the mechanism that puts cold into
a warm shot and the low sun is what puts warm into a cold one.

**Signal colours** (used sparingly, never in the environment):
- `#ff6a2b` — the game's UI signal orange. HUD, markers, objectives.
- `#c0392b` International Orange is *environment*, not UI. Do not confuse them.

**Saturation discipline.** Real San Francisco is not saturated. The saturation comes from
small deliberate hits — a painted Victorian, a neon sign, a police light, a fireball —
against a largely desaturated field. Do not globally crank saturation; place it.

---

## 3. Lighting

- **ACES filmic tonemap, HDR through the whole chain.** Bloom thresholds near 1.0 in
  linear HDR, not "blur everything bright." Banding anywhere in the chain is a bug.
- **The sun is at its real position** for 37.77°N (see `sky/Sky.tsx`). Shadows must fall
  where a San Franciscan expects: sun rising over the East Bay, high in the south at
  midday, setting past the Golden Gate. This is free authenticity and its absence is
  subtly, unplaceably wrong.
- **Never flat.** JC4's most-cited failure. Every scene needs a key/fill/rim separation:
  the sun as key, the sky dome as a *coloured* fill (never grey ambient), and the ground
  bounce as a warm third term. Contact shadows (GTAO) are what stop objects floating.
- **Time of day is the strongest lever we have.** The default presentation slots are
  golden hour and blue hour, because those are when the warm/cold axis is widest. Noon
  is the hardest time to make beautiful and should not be a default anywhere.
- **Night is not "day with a dark blue filter."** At night the city lights *are* the
  lighting: emissive windows, sodium streetlights, headlights, neon. The sky is not black —
  it is a light-polluted brown-orange near the horizon and deep blue above.

---

## 4. Materials

This is where we win or lose, so the standard is high and non-negotiable:

- **No untextured surface, anywhere, ever.** A flat-coloured `MeshStandardMaterial` is a
  bug report, not a placeholder.
- **Every surface gets: albedo variation, a normal map, a roughness map, and cavity/AO.**
  Roughness variation matters more than albedo variation — uniform roughness is the single
  most reliable tell of a cheap renderer.
- **Wear is directional and gravity-aware.** Streaks run *down* from ledges. Grime
  accumulates in crevices and at the base of walls. Edges are worn where hands and traffic
  touch them. Paint fails at the top of south-facing walls first.
- **Nothing tiles visibly.** Layer a large-scale macro variation over the tiling detail;
  break up repetition with per-instance colour and rotation.
- **Triplanar on terrain and large surfaces.** UV stretching on a hillside is unacceptable
  in a city built on hills.
- **Wetness is a first-class material parameter**, driven by the weather system: darker
  albedo, lower roughness, and screen-space reflections doing real work. Wet asphalt under
  streetlights is one of the highest-value-per-effort looks in all of real-time rendering,
  and San Francisco has a legitimate excuse to be wet.

---

## 5. Atmosphere and fog — the thing that must be extraordinary

Fog is not weather here. It is the character of the city and it is our single biggest
opportunity to beat the reference.

- Fog must have an **inversion layer**: it sits *below* an altitude. Standing on Twin Peaks
  in clear sunshine above a white sea filling the valleys, with the downtown towers poking
  through it, is the hero image of this entire project.
- Fog **advects**: it pours in through the Golden Gate from the Pacific in the afternoon,
  spills over the Marin headlands and Twin Peaks like a waterfall, thins over the eastern
  city, and burns off in the morning. It moves with the wind and it churns.
- Fog **scatters light**: Henyey-Greenstein phase, so it glows around the sun. Shadowed
  fog gives light shafts between skyscrapers and through the bridge towers.
- Aerial perspective is mandatory and must agree with the sky. Distant geometry that does
  not haze toward the sky colour is the fastest way to look like a 2004 game.

---

## 6. Water

Called out specifically as Just Cause 4's weakest element, therefore an explicit target.

Requirements: Gerstner swell for silhouette; multi-octave scrolling detail normals that
fade with distance (or the horizon turns to noise); depth-based absorption so shallows go
green and the channel goes near-black; Fresnel-weighted sky reflection; a tight specular
sun lobe *plus* a broad glitter lobe; subsurface glow through wave crests; whitecaps on
steep crests only; shoreline foam banded on the real coastline SDF; and screen-space
reflections of the city on it at night.

The bay is visible from most of the map. It has to hold up at 2 m and at 4 km.

---

## 7. Composition and scale

- **The city is the level design.** SF's hills create the sightlines. Buildings must step
  down slopes. Streets must have real camber and grade. A flattened San Francisco is a
  failed San Francisco.
- **Landmarks are navigation.** Sutro Tower, the Transamerica Pyramid, Coit Tower, the two
  bridges and Salesforce Tower must be identifiable at maximum draw distance — they are how
  the player builds a mental map. Their far-LOD silhouettes matter more than their near
  geometry.
- **Vertical readability.** This is a game about being in the air. From 300 m the street
  grid, the parks, the water and the district character must all read clearly.
- **Density is character.** Chinatown is dense, low and cluttered. The Sunset is an endless
  uniform grid. SoMa is big blocks and wide streets. FiDi is a canyon. If all districts feel
  the same, the generator has failed regardless of how nice any single building looks.

---

## 8. Motion and feel

- 60 fps is a *design constraint*, not an optimisation goal. An effect that is beautiful at
  25 fps is not shipping.
- Camera FOV widens with speed. Wingsuit dives get speed lines, wind roar and FOV push —
  the sensation of velocity is authored, not incidental.
- Everything the player does gets a full feedback stack: visual, audio, haptic, and UI.
  A pistol shot is flash + light + shell + smoke + recoil + aim punch + camera kick + crack
  + building echo + impact particles + decal + hitmarker. Layers are the product.

---

## 9. The critic's checklist

A shot passes only if **all** of these are true:

1. No flat, untextured, or uniformly-rough surface anywhere in frame.
2. Both the warm and the cold side of the palette are present.
3. Clear key/fill/rim separation; nothing looks flatly lit.
4. Contact shadows ground every object; nothing floats.
5. Aerial perspective is present and agrees with the sky.
6. No visible texture tiling, no visible LOD pop, no z-fighting, no shadow acne.
7. The horizon is not noise; distant detail resolves into haze cleanly.
8. It is identifiably **San Francisco**, not a generic city.
9. Composition has foreground, midground and background.
10. The frame is not muddy: there is a real black point and a real highlight.
11. Reported fps is ≥ 30 in the harness and draw calls are not pathological.
12. Asked "which of these two is the real AAA game?", a stranger would not instantly
    pick the other one.

Anything failing 1–11 is a defect, not a matter of taste.
