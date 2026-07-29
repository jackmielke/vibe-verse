# The Game Layer

`src/sf/game/` is the reason to keep playing. The world subsystems build San
Francisco; this one gives you something to do in it, counts what you did, and
decides what the city should do back.

It renders nothing. Everything here is logic that runs on a budget from a
single component, `<GameDirector />`.

---

## The core loop

```
        ┌──────────────────────────────────────────────────────────┐
        │                                                          │
        ▼                                                          │
   DO SOMETHING ──► CHAOS ──► HEAT ──► PRESSURE ──► ESCAPE ────────┤
   (destroy, kill,    │         │                      │           │
    fly, drive)       │         └──► the city responds ┘           │
                      │              (@/sf/ai owns this)           │
                      ▼                                            │
                 CAREER RANK ──► UNLOCKS ──► BIGGER TOOLS ─────────┘
                      │
                      ▼
             THE DIRECTOR watches the intensity it produced,
             paces the world around it, and offers the next thing.
```

Four beats, and each of them feeds the next:

1. **Act.** Blow something up, take a convoy apart, fly a course, find a cache.
2. **Score.** The chaos economy converts the act into points, with a combo
   multiplier for rhythm and style bonuses for *how* you did it.
3. **Consequence.** Chaos and provocations raise heat. The AI's wanted system
   sends the response; the game layer decides how much pressure to send it and
   remembers which districts you keep hitting.
4. **Reward.** Chaos accumulates into a career rank; ranks, missions and
   challenges hand out weapons, tethers and lift, which make step 1 bigger.

The director sits outside the loop watching its amplitude, and shapes it into
peaks and valleys instead of a flat line of noise.

---

## The chaos economy

`chaos.ts`. Three multiplicative layers.

### Base

What the object was worth. `CHAOS.points` in `config.ts` is authoritative for
the classes it names; the economy extends it for the rest.

| class | points | | class | points |
|---|---|---|---|---|
| prop | 5 | | helicopter | 360 |
| vehicle | 40 | | aircraft | 420 |
| billboard | 90 | | boat | 140 |
| fuelTank | 120 | | roadblock | 160 |
| generator | 200 | | structure | 260 |
| tower | 350 | | landmark | 900 |
| enemy | 55 | | officer | 70 |
| elite | 90 | | **civilian** | **−30** |

Civilians score *negative*. Killing bystanders is not chaos, it is noise, and
the economy says so out loud rather than paying you to mow down a crowd.
Negative events also earn no style and no combo.

### Combo

A chain of events inside a rolling window. The window is 3.6 s, extended
slightly by each event to a 6 s ceiling — long enough to cross a street,
short enough that the multiplier is a statement about *momentum*.

| chain | multiplier | rank |
|---|---|---|
| 0 | ×1.0 | — |
| 3 | ×1.3 | ROWDY |
| 6 | ×1.7 | RECKLESS |
| 10 | ×2.2 | UNHINGED |
| 16 | ×3.0 | CATASTROPHIC |
| 24 | ×4.0 | FREE FALL |

Tiered, not linear, on purpose: a linear ramp gives you no moment to cross and
nothing to protect. The gaps widen (3, 6, 10, 16, 24) so the first tier is
reachable by accident and the last one requires a plan.

### Style

What you were doing at the time. Frame-derived tags come off `frame` for free
(airborne, wingsuit, free-fall, one tether, two tethers, car surfing, high
altitude); the weapon and vehicle stacks supply the ones only they can know
(headshot, long shot, chain reaction, environmental, grapple kill).

Each tag pays a small flat bonus **and** adds to the multiplier. That coupling
is the whole design: style without momentum is a shrug, momentum without style
plateaus at ×2, and the two together are how a 5-point prop ends up worth 400.

```
points = (base + Σ styleBonus) × (comboTier + Σ styleMult)
```

Mission and challenge payouts deliberately bypass the combo (`chaos.payout`) —
authored rewards must stay predictable, and completing an objective should not
inflate a multiplier you were riding.

---

## The escalation curve

Career chaos never decays. It is the long axis of the game and it gates the
wanted-level ceiling (`ai/heat`) and the automatic unlocks.

| rank | chaos | |
|---|---|---|
| Tourist | 0 | Nobody has filed a report yet. |
| Nuisance | 600 | The Chronicle ran two column inches. |
| Person of Interest | 1,800 | SFPD opened a file. |
| Public Menace | 4,500 | You made the evening broadcast. |
| City Problem | 11,000 | The mayor's office is taking questions. |
| Statewide Alert | 26,000 | CHP is closing the bridges. |
| Federal Case | 58,000 | Suits at the Ferry Building. |
| Act of God | 125,000 | Insurers have stopped writing policies. |
| FREE FALL | 260,000 | San Francisco is yours. |

Ratio ≈ 2.3 between ranks. Each takes about twice as long as the last, which
keeps the early ranks arriving fast enough to teach the loop and the late ones
meaningful hours in. The absolute numbers are calibrated against an observed
~900 chaos/minute during an ordinary rampage.

---

## Heat

`heat.ts` owns the **scoring** side only. `ai/heat.ts` owns the wanted-level
state machine, the search circle and evasion, and this module does not
duplicate a line of it.

What the game layer adds:

- **Provocation routing.** One typed entry point (`gameHeat.provoke`) that
  missions, destructibles and scripts call, fanning out to
  `aiHeat.reportCrime` with the right witness flag. Three game-layer
  provocations the AI does not know about — `landmark-attack`, `trespass`,
  `sabotage` — are scaled on top rather than reported twice.
- **Ambient pressure.** Sustained chaos-per-minute is converted into periodic
  crime reports, so flattening a block with a silenced launcher from a rooftop
  still brings the city. Reports are filed *where the chaos happened*, which is
  what lets you set a charge and walk away.
- **District memory.** A decaying pressure field over the 24 real districts
  (150 s half-life). Hit the Mission four times in ten minutes and the Mission
  stays touchy; the Presidio does not care. The director reads it when placing
  activities.
- **Terrain assist.** Hiding works, and *where* matters: open water, parks,
  Sutro forest, altitude and fog all bleed heat faster, and a dense district
  cancels most of it. This only ever removes points and only while unseen and
  quiet, so it can never fight the wanted system for control of the level.
- **Pursuit ledger.** Duration, peak level, escapes, time at each level. An
  escape from level *n* pays `140 · n²` chaos — shaking a five is a score event.

---

## The director

`director.ts`. Its job is pacing, not content.

`intensity` is **measured**, not chosen: blended from the wanted level, the
last minute of chaos, live ambient events, and whatever mission is running.
Smoothing is asymmetric — the world gets loud fast and quietens slowly, which
is how tension actually decays for a player.

```
CALM ──► BUILD ──► PEAK ──► COOLDOWN ──► CALM
```

- **Calm** — offers exploration activities, seeds only atmosphere.
- **Build** — events get louder and closer, offers skew to combat.
- **Peak** — bounded to 95 s. No *new* event families are seeded; adding a fire
  to a level-4 chase does not make it exciting, it makes it illegible.
- **Cooldown** — a hard 55–110 s valley with ambient seeding switched off. This
  is the phase most sandboxes skip, and skipping it is exactly why they turn
  into undifferentiated noise after an hour. You cannot feel a peak you never
  came down from.

### Offer scoring

Candidates are scored on a **distance band** (250–2200 m is the sweet spot;
"nearest" scoring hands you the same three things forever), intensity fit
against what the phase wants, novelty of kind and district, replay penalty
(light for timed runs, where beating your own time *is* the content), current
district heat, and **playstyle affinity** read off the progression stats — a
player with 40 km of wingsuit and no driving gets offered courses, not races.
Never more than one of each kind in the top three.

### Ambient events

| kind | phases | what it actually does |
|---|---|---|
| police-chase | calm, build | A siren source snapped to the street grid and driven past you, re-emitting every 1.1 s. Pedestrians react to it. |
| structure-fire | calm, build, cooldown | A real `igniteFire` in a district dense enough to have something to burn — light, smoke, and an audible event. |
| protest | calm, cooldown | 26 pedestrians spawned along the real Market Street centreline near you, with periodic crowd noise. |
| fog-bank | calm, build, cooldown | Ramps `frame.fogDensity` and ground fog in over a third of its duration, holds, and ramps out. SF's own stealth field. |
| ambush | build, peak | A contractor squad on top of you — but only above 0.28 notoriety. Jumping a tourist is a mugging, not a beat. |

Everything random is a seeded fork of the world seed advanced by an event
counter, so a given sequence of player actions always produces the same
sequence of events. The screenshot harness requires it; so does reproducing a
bug report.

When nothing is happening, the director's quietest tool does the most work: it
puts a compass marker on the nearest thing you have not discovered. The answer
to "I don't know what to do" should never be an explosion.

---

## The activity list

34 instances across nine families, all on real coordinates.

| family | count | where |
|---|---|---|
| **Liberation** | 8 | SoMa, Mission, Dogpatch, Chinatown, Western Addition, Bayview, Embarcadero, Civic Center. A seeded strongpoint inside the district: 4–6 destructible emplacements plus a garrison to clear. |
| **Chaos Run** | 10 | FiDi, SoMa, Mission, Chinatown, North Beach, Marina, Haight, Potrero, Dogpatch, Richmond. A chaos target scaled by district density, on a 150–200 s clock, counted only inside the district. |
| **Wingsuit Course** | 2 | *Peaks to the Ferry* — 14 gates from the summit of Twin Peaks down the Market Street diagonal to the Ferry Building. *The Golden Gate Run* — 12 gates off the Marin Headlands, between the bridge towers below deck level, along Crissy Field to Marina Green. |
| **Grapple Trial** | 2 | *Rooftops of the Financial District* — Transamerica → 555 California → Millennium → Salesforce → Ferry Building, at real building heights. *Grace to the Tower* — Grace Cathedral down through Chinatown and up Telegraph Hill to Coit. |
| **Convoy** | 2 | *Embarcadero Convoy* — four armoured trucks running Oracle Park to Pier 39 along the waterfront. *Bridge Run* — a prisoner transport and two escorts on the western span of the Bay Bridge, at deck height. |
| **Extraction** | 3 | Civic Center → Ferry Building; Mission → Oracle Park helipad; Grant Avenue → Coit Tower. A ward that follows you, takes fire, and must arrive alive. |
| **Demolition** | 4 | Sutro Tower (6 anchors, 8 charges), Pier 70 cranes, a SoMa fuel depot, the Hunters Point stacks. Limited charges; running out fails the mission. |
| **Race** | 2 | *The Hill Climb* — Fort Mason to Twin Peaks with Lombard's switchbacks as a checkpoint. *Ocean to Bernal* — Ocean Beach through Golden Gate Park, the Haight and the Castro to Bernal Heights. |
| **Assault** | 1 | *Take the Rock* — six emplacements on Alcatraz, clear the island, stand on the cellhouse, hold it 90 seconds. |

### How a mission is put together

Objectives are typed conditions grouped into **stages**; everything in a stage
runs simultaneously and the stage advances when its non-optional objectives are
satisfied. Eight kinds: `reach`, `gates`, `checkpoints`, `destroy`, `chaos`,
`clear`, `survive`, `escort`.

Failure conditions are declarative: time limit, leash distance, death, ward
death, resource exhaustion.

**Mission actors** are the things a mission owns that are not scenery — the
escort ward, convoy trucks, strongpoint targets. The game layer simulates them
(route following, follow-the-player, health, death) and publishes them on
`missions.actors` for the character and vehicle renderers to draw. Targets
additionally register with `@/sf/physics/destruction`, so rockets, chained
blasts and shard debris all work on them with no special case; convoy vehicles
and wards take blast damage through an explosion subscription and can be hurt
by anything via `missions.damageActor(id, amount)`.

---

## Progression

`progression.ts` — stats, challenges, unlocks, and the derived tuning object.

**Stats** are integrated from `frame` at ~3 Hz: distance split by movement mode,
air time, top speed, highest altitude, longest *survived* fall, plus counters
other systems push in (kills, headshots, vehicles, props, hijacks, deaths).

**Challenges** (20) are named goals over those stats — "survive a 200 m fall",
"fly 2,500 m in one flight", "reach a 24 event chain", "discover every
landmark". They pay chaos and often an unlock.

**Unlocks** arrive from three sources — career rank (automatic), mission reward
tokens, challenges — and all three funnel through `grant()` so the
notification, the save write and the recomputed tuning happen in one place.

Player systems read the results off a plain object:

```ts
import { upgrades } from "@/sf/game";

upgrades.maxTethers        // 2 → 3 → 4
upgrades.grappleRange      // metres, already scaled (×1.45, ×1.9)
upgrades.reelAcceleration  // and maxReelSpeed (×1.35, ×1.75)
upgrades.boostFuel         // wingsuit (×1.6, ×2.3), boostRefill
upgrades.lift              // (×1.15, ×1.3) and a lowered stallSpeed
upgrades.flareStrength     // parachute
upgrades.vehicleTune       // ×1.12
upgrades.maxHealth / regenDelay / regenRate
upgrades.weapons           // available registry keys, in HUD order
```

No events to subscribe to and no per-frame cost — the object only changes when
something is unlocked.

---

## Discoveries

`discoveries.ts`. Three families, ~110 entries, all keyed to the real city.

- **Landmarks** (22) — every entry in `LANDMARKS`, each with a short, true,
  specific fact about the real place. Irving Morrow choosing International
  Orange over the Navy's black-and-yellow stripes. The Ferry Building clock
  stopping at 5:12 a.m. on 18 April 1906. The sea lions arriving at Pier 39
  months after Loma Prieta and never leaving. If the fact is not interesting,
  the discovery is not worth having.
- **Viewpoints** (16) — one on each real summit in `SUMMITS`. You must be *at
  the top*, not merely near the hill, which makes them traversal challenges
  rather than map dots.
- **Hidden** (~72) — seeded caches through the 24 districts. Deterministic
  placement, water- and exclusion-rejected, district-verified, so they are
  always physically reachable.

Detection is a 3×3 uniform-grid query at 10 Hz: a handful of distance checks
per tick regardless of catalogue size.

---

## Persistence

`save.ts`. Versioned (v2), migration-chained, and it **never throws**.

Storage can be absent (SSR, the shot harness), disabled, full, or corrupt.
Every one of those is normal and none may take the game down — failures degrade
to an in-memory store plus a `lastError` string. A save file is untrusted
input: every field is type- and range-checked on the way in, unknown unlock,
mission and discovery ids are dropped, and a save written by a newer build
cannot break an older one.

A save from a different `WORLD_SEED` describes a city that no longer exists, so
the career (chaos, unlocks, stats, challenges) is kept and the geography
(discoveries, mission completions) is dropped.

Autosave is debounced to 30 s and only writes when something changed; mission
completion forces an immediate write; `visibilitychange` and `pagehide` flush.
Serialisation runs on a slow director slot, never inside a frame budget.

---

## The frame budget

`GameDirector.tsx` owns the schedule.

| rate | what | why |
|---|---|---|
| every frame | chaos combo window, heat pressure field, mission objectives | Cheap, and a gate that registers 100 ms late feels broken. |
| 10 Hz | discovery proximity | Nine grid cells. Still finer than the smallest trigger radius at wingsuit speed. |
| ~3 Hz, rotated | director, progression, autosave | One per slow tick so their costs never land on the same frame. Each receives real elapsed time, so the lower rate changes none of its numbers. |

Ordering is deliberate: chaos before heat (heat reads the chaos rate), heat
before the director (the director reads notoriety), missions last so an
objective completed this frame sees a settled world.

`<GameDirector />` must mount **after** `<CityAI />`, because the AI's effect
installs the enemy and pedestrian kill callbacks and the chaos economy adopts
whatever it finds there. If the order ever slips, `refreshChaosHooks()` on the
director tick re-adopts them within a third of a second.

The whole layer switches off automatically when the offline screenshot harness
has requested a pose — a director that lights fires and rolls fog in would make
every capture a different scene.
