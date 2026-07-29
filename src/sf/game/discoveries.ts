/**
 * game/discoveries.ts — the exploration layer.
 *
 * An open world earns the word "open" by rewarding the player for looking at
 * it. Three collectible families, all keyed to the real city:
 *
 *   LANDMARKS   every entry in `LANDMARKS`. Getting close unlocks a short,
 *               genuinely true blurb about the real place. No filler, no
 *               "this is a famous bridge" — if the fact is not interesting,
 *               the discovery is not worth having.
 *   VIEWPOINTS  one on each of the sixteen real summits in `SUMMITS`. You must
 *               actually be *at the top*, not merely near the hill, which is
 *               what makes them traversal challenges rather than map dots.
 *   HIDDEN      seeded caches scattered through the 24 districts. Placement is
 *               deterministic (world seed → district fork), avoids water and
 *               exclusion zones, and prefers park/street ground so they are
 *               always physically reachable.
 *
 * Detection runs against a uniform grid rather than the full list: with ~110
 * discoveries a linear scan would be fine, but the grid keeps the per-frame
 * cost flat if the hidden-item count is ever turned up, and it costs one
 * Map lookup per cell.
 *
 * Public API
 * ----------
 *   DISCOVERIES / DISCOVERY_BY_KEY / discoveriesInDistrict(key)
 *   discoveries.tick()            proximity test on a budget
 *   discoveries.found / total / fraction
 *   discoveries.hydrate(keys) / discoveries.reset()
 *   nearestUndiscovered(x, z)     the director's "go look at this" source
 */
import { WORLD_SEED } from "../config";
import { frame, useSfStore } from "../state/store";
import { makeRng } from "../math/rng";
import {
  DISTRICTS,
  LANDMARKS,
  SUMMITS,
  districtAt,
  isExcluded,
  isPark,
  isWater,
  walkableHeight,
  type District,
} from "../geo/sfGeo";
import { chaos } from "./chaos";

export type DiscoveryKind = "landmark" | "viewpoint" | "hidden";

export interface Discovery {
  key: string;
  kind: DiscoveryKind;
  name: string;
  /** One or two sentences of true, specific fact about the real place. */
  blurb: string;
  x: number;
  y: number;
  z: number;
  /** Horizontal trigger radius, metres. */
  radius: number;
  /** Minimum altitude to count, world Y. Only viewpoints use it. */
  minY: number;
  /** Chaos paid on first discovery. */
  reward: number;
  /** District key, for the map screen's completion counters. */
  district: string;
}

/* ================================================================== *
 * Landmark facts
 * ================================================================== *
 * Written from the real history of each place. Kept to two sentences: long
 * enough to teach something, short enough that a player reads it mid-air.
 */
const LANDMARK_BLURB: Record<string, string> = {
  "golden-gate":
    "The International Orange was picked by consulting architect Irving Morrow over the Navy's proposal of black with yellow stripes. The towers sway up to eight metres in a gale, and a permanent crew repaints the span continuously — they never finish.",
  "bay-bridge":
    "Two separate bridges pretending to be one, meeting inside Yerba Buena Island. The eastern span dropped a deck section in the 1989 Loma Prieta quake and was replaced in 2013 by the widest bridge ever built.",
  transamerica:
    "Loathed on sight in 1972, adopted as the city's emblem within a decade. The taper is structural — it sheds wind load and lets daylight reach the street — and the top 65 metres is a hollow, windowless spire.",
  salesforce:
    "At 326 metres it is the tallest building in San Francisco, standing on 42 piles driven ninety metres to bedrock. That foundation was a direct answer to the Millennium Tower sinking two blocks away.",
  coit:
    "Built in 1933 with money left by Lillie Hitchcock Coit, who as a girl chased fire engines around North Beach. The architects always denied it was shaped like a hose nozzle; the lobby murals were painted by 26 artists on a New Deal commission.",
  ferry:
    "Its clock tower copies the Giralda in Seville. The clock stopped at 5:12 a.m. on 18 April 1906 — and before the bridges opened, fifty thousand commuters a day walked through this building.",
  "painted-ladies":
    "Postcard Row on Steiner Street, built 1892-96 by Matthew Kavanaugh, who kept the big house behind for himself. Roughly 48,000 Victorians went up in San Francisco; about 16,000 survived the fire.",
  palace:
    "The last survivor of the 1915 Panama-Pacific Exposition, originally built as deliberate fake ruins in plaster and burlap. The city loved it enough to recast the whole thing in concrete in the 1960s rather than watch it crumble.",
  alcatraz:
    "A military prison for eighty years before it was a federal one. Thirty-six men attempted escape; the 1962 raincoat-raft break by the Anglin brothers has never been resolved, and the island was occupied by Native American activists from 1969 to 1971.",
  lombard:
    "Not the crookedest street in the world — Vermont Street on Potrero Hill turns tighter. The eight switchbacks were cut in 1922 to tame a 27 percent grade that early cars simply could not climb.",
  "city-hall":
    "Its dome stands about twelve metres taller than the one on the US Capitol. Rebuilt in 1915 after the 1906 quake flattened its predecessor, it now rides on 530 base isolators that let the whole building slide nearly a metre.",
  "oracle-park":
    "The right field wall is twenty-four feet high, for Willie Mays. Balls that clear it land in McCovey Cove, where kayakers wait and every splash hit is counted on a scoreboard.",
  "powell-turnaround":
    "Cable cars have no engine and no reverse: the grip clamps a steel cable running under the street at a constant 9.5 mph. At Powell and Market the crew turns each car by hand on a wooden turntable.",
  pier39:
    "The sea lions turned up a few months after the 1989 earthquake and never left, and the marina eventually surrendered the berths to them. The colony peaks near nine hundred animals in winter.",
  sutro:
    "297 metres of antenna standing on a 250-metre hill, which makes it the tallest structure in the city and visible from almost all of it. San Franciscans hated it in 1973; it now has a fan club and a fog-obsessed online following.",
  "chinatown-gate":
    "The Dragon Gate on Grant Avenue was a 1970 gift from Taiwan, built to authentic proportions with the dragons facing outward to repel evil. The neighbourhood behind it is the oldest Chinatown in North America.",
  sfmoma:
    "The first museum on the West Coast devoted entirely to modern art, founded in 1935. The 2016 expansion tripled the galleries and is wrapped in seven hundred fibreglass panels rippled to catch the bay light.",
  grace:
    "The bronze doors are casts taken from Ghiberti's Gates of Paradise in Florence. The Crockers donated the burned-out site of their mansion after 1906, and the nave holds a replica of the Chartres labyrinth.",
  millennium:
    "Fifty-eight storeys founded in dense mud instead of bedrock. It has settled about 45 centimetres and leans measurably to the northwest — a pile retrofit was driven along two sides in 2021.",
  "555cal":
    "Bank of America's headquarters until 1998, clad in carnelian granite that goes almost black at dusk. The black plaza sculpture is officially titled Transcendence; everyone in the city calls it the Banker's Heart.",
  cranes:
    "The Pier 70 gantries served a shipyard that has built vessels since 1883, and employed eighteen thousand people during the Second World War. It is the oldest civilian shipyard in continuous operation on the West Coast.",
  windmill:
    "The Dutch Windmill at the ocean end of Golden Gate Park once pumped thirty thousand gallons an hour of groundwater to irrigate the park, turning bare sand dunes into forest. Built in 1902, restored in 1981.",
};

/* ================================================================== *
 * Summit viewpoints
 * ================================================================== */

const SUMMIT_BLURB: Record<string, string> = {
  "Twin Peaks":
    "The Spanish called them Los Pechos de la Choca. At 282 metres they are the second-highest point in the city and the reason half of San Francisco has a view of the other half.",
  "Mount Davidson":
    "The highest point in San Francisco by a single metre. The 31-metre concrete cross on the summit was sold to an Armenian-American group in 1997 after a decade of court fights over church and state.",
  "Mount Sutro":
    "Adolph Sutro planted the whole hill with eucalyptus and blue gum in the 1880s. The result is a cloud forest that strips water out of the fog and rains it onto the ground below.",
  "Buena Vista":
    "San Francisco's oldest park, set aside in 1867. The gutters on its paths are lined with broken headstones from the city cemeteries that were cleared out to Colma.",
  "Corona Heights":
    "A bare chert outcrop scraped raw by a brickworks that quarried it until the 1920s. The exposed red rock is Franciscan chert, deep-ocean sediment folded up out of the seafloor.",
  "Bernal Heights":
    "The grassy dome south of the Mission, and one of the few hills the fog usually clears. The Bernal fault runs beneath it; the summit is radio-mast bare and windy year round.",
  "Potrero Hill":
    "Sunniest neighbourhood in the city — it sits in the lee of Twin Peaks, which wrings the fog dry before it gets here. The 20th and Rhode Island slope is a 31 percent grade.",
  "Pacific Heights":
    "The ridge the money moved to after 1906, because it burned less and looked better. Broadway between Divisadero and Lyon is still the most expensive street in San Francisco.",
  "Lone Mountain":
    "Once the centre of four cemeteries holding most of the city's dead. The graves were moved to Colma in the 1930s and a university was built on top of them.",
  "Nob Hill":
    "Named for the nabobs — the Big Four railroad barons who built mansions here. All of them burned in 1906 except the Flood house, whose brownstone walls held.",
  "Russian Hill":
    "Named for a small Russian cemetery found near the summit by the first American settlers. The crooked block of Lombard is on its northern slope.",
  "Telegraph Hill":
    "A semaphore on this summit signalled arriving ships to the city below in the 1840s. Its eastern face is a cliff because quarry crews blasted it away for ballast and seawall stone.",
  "Rincon Hill":
    "The city's first fashionable address, cut in half in 1869 by the Second Street Cut and finished off by the Bay Bridge approach. It is now a forest of residential towers.",
  "Presidio Ridge":
    "A military post continuously garrisoned from 1776 to 1994 — Spanish, then Mexican, then American — and now a national park with an airfield in the middle of it.",
  "Lands End":
    "The wrecked-ship coast. At low tide you can still see the ribs of steamers that missed the Golden Gate in fog; the Sutro Baths ruins are just below.",
  "Marin Headlands":
    "Serpentine and pillow basalt raised from the ocean floor, hollowed out with gun batteries that guarded the Gate from the 1890s to the Cold War. Best view of the bridge there is.",
};

/* ================================================================== *
 * Hidden items
 * ================================================================== */

interface HiddenTemplate {
  suffix: string;
  blurb: (d: District) => string;
}

/**
 * Hidden items are flavoured by *kind* rather than authored one by one — the
 * district supplies the specificity. This keeps 70-odd caches interesting
 * without seventy paragraphs of writing that nobody would read twice.
 */
const HIDDEN_TEMPLATES: readonly HiddenTemplate[] = [
  {
    suffix: "Cache",
    blurb: (d) => `Somebody has been stashing gear behind a hoarding in ${d.name}. They will not miss it.`,
  },
  {
    suffix: "Mural",
    blurb: (d) =>
      `A wall painting in ${d.name}, unsigned and repainted at least three times. San Francisco has over a thousand murals; nobody has ever managed a full count.`,
  },
  {
    suffix: "Time Capsule",
    blurb: (d) =>
      `A sealed tin buried under the pavement in ${d.name}. Newspaper, coins, and a note to whoever dug it up.`,
  },
  {
    suffix: "Survey Marker",
    blurb: (d) =>
      `A brass benchmark set into the kerb in ${d.name}. The city is still measured from discs like this one, quietly, every year.`,
  },
  {
    suffix: "Fog Horn",
    blurb: (d) =>
      `A decommissioned horn crated up in ${d.name}. The bay's horns are tuned to different pitches so a pilot can tell them apart in zero visibility.`,
  },
];

/** Hidden items per district, scaled by how much of it is actually built on. */
function hiddenCountFor(d: District): number {
  return d.density > 0.8 ? 4 : d.density > 0.5 ? 3 : 2;
}

/* ================================================================== *
 * Build the catalogue
 * ================================================================== */

function buildDiscoveries(): Discovery[] {
  const out: Discovery[] = [];

  for (const l of LANDMARKS) {
    const blurb = LANDMARK_BLURB[l.key];
    if (!blurb) continue;
    out.push({
      key: `landmark:${l.key}`,
      kind: "landmark",
      name: l.name,
      blurb,
      x: l.x,
      y: walkableHeight(l.x, l.z),
      z: l.z,
      // Big landmarks (bridges) have huge cull radii; the trigger should be a
      // "you are here" distance, not the whole span.
      radius: Math.min(140, Math.max(40, l.radius * 0.45)),
      minY: -Infinity,
      reward: 260,
      district: districtAt(l.x, l.z).key,
    });
  }

  for (const s of SUMMITS) {
    const blurb = SUMMIT_BLURB[s.name];
    if (!blurb) continue;
    const ground = walkableHeight(s.x, s.z);
    out.push({
      key: `viewpoint:${s.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      kind: "viewpoint",
      name: `${s.name} Viewpoint`,
      blurb,
      x: s.x,
      y: ground,
      z: s.z,
      radius: 55,
      // You have to be near the actual top. 18 m of slack allows for the
      // terrain solver disagreeing with the summit table by a few metres.
      minY: ground - 18,
      reward: 180,
      district: districtAt(s.x, s.z).key,
    });
  }

  // Hidden caches. One RNG fork per district so adding a district later does
  // not reshuffle every other district's placements.
  for (const d of DISTRICTS) {
    const rng = makeRng(`${WORLD_SEED}:discoveries:${d.key}`);
    const want = hiddenCountFor(d);
    let placed = 0;
    for (let attempt = 0; attempt < want * 40 && placed < want; attempt++) {
      // Rejection-sample inside the district disc, biased outward so caches do
      // not all pile onto the district centroid.
      const a = rng.next() * Math.PI * 2;
      const r = d.radius * (0.25 + 0.7 * Math.sqrt(rng.next()));
      const x = d.x + Math.cos(a) * r;
      const z = d.z + Math.sin(a) * r;
      if (isWater(x, z)) continue;
      // Landmark footprints are already discoveries; do not stack on them.
      if (isExcluded(x, z) && !isPark(x, z)) continue;
      if (districtAt(x, z).key !== d.key) continue;

      const t = HIDDEN_TEMPLATES[placed % HIDDEN_TEMPLATES.length];
      out.push({
        key: `hidden:${d.key}:${placed}`,
        kind: "hidden",
        name: `${d.name} ${t.suffix}`,
        blurb: t.blurb(d),
        x,
        y: walkableHeight(x, z),
        z,
        radius: 11,
        minY: -Infinity,
        reward: 420,
        district: d.key,
      });
      placed++;
    }
  }

  return out;
}

export const DISCOVERIES: readonly Discovery[] = buildDiscoveries();

export const DISCOVERY_BY_KEY: Record<string, Discovery> = Object.fromEntries(
  DISCOVERIES.map((d) => [d.key, d]),
);

export function discoveriesInDistrict(districtKey: string): Discovery[] {
  return DISCOVERIES.filter((d) => d.district === districtKey);
}

/* ================================================================== *
 * Spatial index
 * ================================================================== */

const CELL = 260;
const cellKey = (cx: number, cz: number) => cx * 8192 + cz;

const GRID = new Map<number, number[]>();
for (let i = 0; i < DISCOVERIES.length; i++) {
  const d = DISCOVERIES[i];
  const cx = Math.floor(d.x / CELL);
  const cz = Math.floor(d.z / CELL);
  const k = cellKey(cx, cz);
  let list = GRID.get(k);
  if (!list) GRID.set(k, (list = []));
  list.push(i);
}

/* ================================================================== *
 * Runtime
 * ================================================================== */

class DiscoverySystem {
  /** Keys already found, mirrored into the store's `discovered` array. */
  private foundSet = new Set<string>();
  /** Most recently unlocked discovery, for the codex pop-up. */
  last: Discovery | null = null;
  lastTime = -1e9;

  /** Listeners for a fresh discovery (audio stinger, codex card). */
  private listeners: ((d: Discovery) => void)[] = [];

  get found(): number {
    return this.foundSet.size;
  }
  get total(): number {
    return DISCOVERIES.length;
  }
  get fraction(): number {
    return DISCOVERIES.length ? this.foundSet.size / DISCOVERIES.length : 0;
  }

  has(key: string): boolean {
    return this.foundSet.has(key);
  }

  countOfKind(kind: DiscoveryKind): number {
    let n = 0;
    for (const k of this.foundSet) {
      const d = DISCOVERY_BY_KEY[k];
      if (d && d.kind === kind) n++;
    }
    return n;
  }

  onDiscover(fn: (d: Discovery) => void): () => void {
    this.listeners.push(fn);
    return () => {
      const i = this.listeners.indexOf(fn);
      if (i >= 0) {
        this.listeners[i] = this.listeners[this.listeners.length - 1];
        this.listeners.pop();
      }
    };
  }

  /**
   * Proximity test. Only the 3×3 grid cells around the player are considered,
   * so this is a handful of distance checks regardless of catalogue size — it
   * is safe to call at the director's tick rate.
   */
  tick(): void {
    const px = frame.position.x;
    const py = frame.position.y;
    const pz = frame.position.z;
    const cx = Math.floor(px / CELL);
    const cz = Math.floor(pz / CELL);

    for (let ox = -1; ox <= 1; ox++) {
      for (let oz = -1; oz <= 1; oz++) {
        const list = GRID.get(cellKey(cx + ox, cz + oz));
        if (!list) continue;
        for (let i = 0; i < list.length; i++) {
          const d = DISCOVERIES[list[i]];
          if (this.foundSet.has(d.key)) continue;
          if (py < d.minY) continue;
          const dx = px - d.x;
          const dz = pz - d.z;
          if (dx * dx + dz * dz > d.radius * d.radius) continue;
          this.unlock(d);
        }
      }
    }
  }

  /** Mark a discovery found and pay for it. Idempotent. */
  unlock(d: Discovery): void {
    if (this.foundSet.has(d.key)) return;
    this.foundSet.add(d.key);
    this.last = d;
    this.lastTime = frame.time;

    const store = useSfStore.getState();
    store.discover(d.key);
    store.notify(
      d.kind === "hidden" ? `Found: ${d.name}` : `Discovered: ${d.name}`,
      "unlock",
    );
    chaos.payout(d.reward, d.name);

    for (let i = 0; i < this.listeners.length; i++) this.listeners[i](d);
  }

  /** Restore from a save. Unknown keys (from a newer build) are ignored. */
  hydrate(keys: readonly string[]): void {
    const store = useSfStore.getState();
    for (const k of keys) {
      if (!DISCOVERY_BY_KEY[k]) continue;
      this.foundSet.add(k);
      store.discover(k);
    }
  }

  /** Serialisable list for the save file. */
  serialize(): string[] {
    return Array.from(this.foundSet);
  }

  reset(): void {
    this.foundSet.clear();
    this.last = null;
    this.lastTime = -1e9;
  }
}

export const discoveries = new DiscoverySystem();

/**
 * Nearest discovery the player has not found. The director uses this to point
 * a bored player at something, and the map screen uses it for the "closest
 * secret" readout. `kind` narrows it when the director wants a specific
 * flavour of nudge.
 */
export function nearestUndiscovered(
  x: number,
  z: number,
  kind?: DiscoveryKind,
  maxDistance = Infinity,
): Discovery | null {
  let best: Discovery | null = null;
  let bestD = maxDistance * maxDistance;
  for (let i = 0; i < DISCOVERIES.length; i++) {
    const d = DISCOVERIES[i];
    if (kind && d.kind !== kind) continue;
    if (discoveries.has(d.key)) continue;
    const dx = x - d.x;
    const dz = z - d.z;
    const dd = dx * dx + dz * dz;
    if (dd < bestD) {
      bestD = dd;
      best = d;
    }
  }
  return best;
}

/** Completion counters per district, for the map screen. */
export function districtCompletion(districtKey: string): { found: number; total: number } {
  let found = 0;
  let total = 0;
  for (const d of DISCOVERIES) {
    if (d.district !== districtKey) continue;
    total++;
    if (discoveries.has(d.key)) found++;
  }
  return { found, total };
}
