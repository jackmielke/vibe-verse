/**
 * materials.ts — the landmark palette.
 *
 * Everything here is a thin, *named* wrapper over `@/sf/materials`. The naming
 * matters more than it looks: a builder that says `M.internationalOrange()` is
 * self-documenting, and when the art director decides the Golden Gate is
 * reading too pink there is exactly one line to change rather than eleven
 * scattered `getMaterial("steel-painted", { color: 0x... })` calls.
 *
 * Two policies apply throughout:
 *
 * **Triplanar everywhere.** Landmark geometry is lofted, extruded, swept and
 * lathed; almost none of it has a UV set worth defending. World-space
 * projection means a 2.7 km bridge deck, a 40 m dome and a hand-cut cliff skirt
 * all get the same texel density with no UV work at all, and adjacent landmarks
 * never disagree about scale.
 *
 * **Tint, do not re-bake.** `material.color` multiplies the baked albedo, so a
 * tint can only ever darken. The library's near-neutral recipes (`plastic`,
 * `stucco`, `wood-siding`, `marble-civic`, `victorian-trim`, `brick-painted`)
 * are the ones to tint; the strongly-coloured ones (`steel-painted` is already
 * International Orange, `brick-red` is already fired clay) are used as-is.
 */
import * as THREE from "three";
import { getMaterial, type MaterialOptions } from "../../materials";

/**
 * Cached wrapper. `getMaterial` has its own cache keyed on every uniform, so
 * this second layer exists only to keep the option objects (and therefore the
 * cache keys) byte-identical between calls.
 */
const cache = new Map<string, THREE.MeshStandardMaterial>();

function mat(
  key: string,
  kind: Parameters<typeof getMaterial>[0],
  o: MaterialOptions,
): THREE.MeshStandardMaterial {
  const hit = cache.get(key);
  if (hit) return hit;
  const m = getMaterial(kind, { ...o, name: `sf/landmark/${key}` });
  cache.set(key, m);
  return m;
}

/** Painted metal in an arbitrary colour, at an arbitrary tiling scale. */
function painted(key: string, color: number, worldScale: number, macro = 0.8) {
  return mat(key, "plastic", {
    color,
    triplanar: { worldScale, detailScale: 5, macroStrength: macro },
  });
}

/* ------------------------------------------------------------------ *
 * Steel and iron
 * ------------------------------------------------------------------ */

/**
 * The Golden Gate's own colour. The `steel-painted` recipe bakes International
 * Orange with rivet lines, seam plates, chipped arrises and red-oxide primer
 * showing through — it exists for this bridge, so it is used untinted.
 */
export const internationalOrange = () =>
  mat("intl-orange", "steel-painted", {
    triplanar: { worldScale: 2.2, detailScale: 4, macroStrength: 0.7 },
  });

/** Slightly deepened orange for the shadowed inner faces of the tower legs. */
export const orangeShadowed = () =>
  mat("intl-orange-deep", "steel-painted", {
    color: 0xd8ccc4,
    triplanar: { worldScale: 2.2, detailScale: 4 },
  });

/**
 * Painted anything, in any colour. `plastic` is baked deliberately near-neutral
 * with a fine brushed grain, so tinting it gives a convincing coat of paint on
 * steel, timber or render without another texture bake.
 */
export const paintedColour = (color: number, worldScale = 2.0) =>
  painted(`paint-${color.toString(16)}-${worldScale}`, color, worldScale);

/** Bay Bridge / Sutro Tower white — aviation and highway paint on steel. */
export const paintedWhite = () => painted("paint-white", 0xe8e6df, 2.4);
/** Sutro Tower's aviation red bands. Close cousin of International Orange. */
export const aviationRed = () =>
  mat("aviation-red", "steel-painted", {
    color: 0xf0d2c8,
    triplanar: { worldScale: 1.8, detailScale: 4 },
  });
/** The Bay Bridge's silver-grey structural steel. */
export const bridgeSilver = () => painted("paint-silver", 0xa8adb2, 3.0);
/** Dark structural steel — truss webs, hangers, catwalks, crane booms. */
export const darkSteel = () => painted("paint-darksteel", 0x4d5257, 1.6);
/** Weathered, part-rusted steel: shipyard cranes, pier ironwork, Alcatraz. */
export const weatheredSteel = () =>
  mat("weathered-steel", "steel-rusted", {
    triplanar: { worldScale: 2.4, detailScale: 4 },
  });
/** Galvanised sheet — utility sheds, tank cladding, crane housings. */
export const galvanised = () =>
  mat("galvanised", "corrugated-metal", {
    triplanar: { worldScale: 2.0, detailScale: 3 },
  });
/** Polished metal: handrails, brass poles, finials. */
export const brightMetal = (color = 0xffffff) =>
  mat(`chrome-${color.toString(16)}`, "chrome", {
    color,
    triplanar: { worldScale: 0.9 },
    envMapIntensity: 2.2,
  });
/** Gilded ornament — City Hall's dome ribs and lantern, the windmill's vane. */
export const goldLeaf = () =>
  mat("gold-leaf", "chrome", {
    color: 0xc9922e,
    triplanar: { worldScale: 0.7 },
    envMapIntensity: 2.6,
  });

/* ------------------------------------------------------------------ *
 * Stone and concrete
 * ------------------------------------------------------------------ */

/** Board-formed structural concrete: bridge piers, anchorages, cellhouse. */
export const concrete = (color = 0xffffff) =>
  mat(`concrete-${color.toString(16)}`, "concrete-cast", {
    color,
    triplanar: { worldScale: 4, detailScale: 4 },
  });
/** Pale precast — the Transamerica's crushed-quartz panels. */
export const quartzPrecast = () =>
  mat("quartz-precast", "concrete-cast", {
    color: 0xf2ece0,
    triplanar: { worldScale: 3.2, detailScale: 5, macroStrength: 0.55 },
  });
/** Civic granite / limestone ashlar: City Hall, the Palace, Grace Cathedral. */
export const civicStone = (color = 0xffffff) =>
  mat(`civic-stone-${color.toString(16)}`, "marble-civic", {
    color,
    triplanar: { worldScale: 2.4, detailScale: 4 },
  });
/** The dark carnelian granite of 555 California. */
export const carnelianGranite = () =>
  mat("carnelian", "marble-civic", {
    color: 0x8a5347,
    triplanar: { worldScale: 2.0, detailScale: 4 },
  });
/** Paving: plazas, sidewalks, station aprons. */
export const paving = (color = 0xffffff) =>
  mat(`paving-${color.toString(16)}`, "concrete-sidewalk", {
    color,
    triplanar: { worldScale: 6, upBias: 1.4 },
  });
/** Roadway. */
export const asphalt = () =>
  mat("asphalt", "asphalt", { triplanar: { worldScale: 8, upBias: 1.6 } });
/** Lane markings, crosswalks, the turntable's painted ring. */
export const roadPaint = (color = 0xffffff) =>
  mat(`roadpaint-${color.toString(16)}`, "road-marking-paint", {
    color,
    triplanar: { worldScale: 1.2, upBias: 2 },
    polygonOffset: -2,
  });
/** Brick: Ferry Building plinths, Lombard's paving, Oracle Park's outfield wall. */
export const brick = (color = 0xffffff) =>
  mat(`brick-${color.toString(16)}`, "brick-red", {
    color,
    triplanar: { worldScale: 1.632, detailScale: 4 },
  });
/** Painted masonry — Alcatraz's cellhouse render, the Palace's colonnade infill. */
export const paintedMasonry = (color: number) =>
  mat(`brickpaint-${color.toString(16)}`, "brick-painted", {
    color,
    triplanar: { worldScale: 1.632, detailScale: 4 },
  });
/** Stucco render, tinted per building. */
export const stucco = (color: number) =>
  mat(`stucco-${color.toString(16)}`, "stucco", {
    color,
    triplanar: { worldScale: 3, detailScale: 4 },
  });
/** Terracotta ornament and glazed tile — Chinatown Gate, Ferry Building cornice. */
export const terracotta = (color = 0xffffff) =>
  mat(`terracotta-${color.toString(16)}`, "terracotta", {
    color,
    triplanar: { worldScale: 1.5, detailScale: 3 },
  });

/* ------------------------------------------------------------------ *
 * Timber and finishes
 * ------------------------------------------------------------------ */

/** Painted clapboard — every Victorian, the Pier 39 shops, the windmill cap. */
export const clapboard = (color: number) =>
  mat(`clapboard-${color.toString(16)}`, "wood-siding", {
    color,
    triplanar: { worldScale: 2.0, detailScale: 5 },
  });
/** The ornamental trim band that makes a Victorian a Victorian. */
export const victorianTrim = (color: number) =>
  mat(`vtrim-${color.toString(16)}`, "victorian-trim", {
    color,
    triplanar: { worldScale: 1.2, detailScale: 4 },
  });
/** Heavy timber: pier decking, wharf piles, the cable car turntable. */
export const deckTimber = (color = 0xc8bda8) =>
  mat(`deck-timber-${color.toString(16)}`, "wood-siding", {
    color,
    triplanar: { worldScale: 1.4, detailScale: 4 },
  });
/** Mission tile / slate roofing. */
export const roofTile = (color = 0xffffff) =>
  mat(`rooftile-${color.toString(16)}`, "roof-tile", {
    color,
    triplanar: { worldScale: 2, detailScale: 3 },
  });
/** Flat commercial roofing. */
export const flatRoof = () =>
  mat("flat-roof", "roof-tar-gravel", { triplanar: { worldScale: 4, upBias: 1.5 } });

/* ------------------------------------------------------------------ *
 * Glazing
 * ------------------------------------------------------------------ */

/** Daytime curtain wall. */
export const curtainGlass = (color = 0xffffff) =>
  mat(`glass-${color.toString(16)}`, "glass-curtainwall", {
    color,
    triplanar: { worldScale: 3, detailScale: 2 },
    envMapIntensity: 2.4,
  });
/** Lit interior glazing — offices at dusk, the cellhouse's caged windows. */
export const litGlass = (color = 0xffffff, intensity = 2.2) =>
  mat(`glasslit-${color.toString(16)}-${intensity}`, "glass-window-lit", {
    color,
    triplanar: { worldScale: 3 },
    emissiveIntensity: intensity,
  });

/* ------------------------------------------------------------------ *
 * Landscape
 * ------------------------------------------------------------------ */

export const grass = (color = 0xffffff) =>
  mat(`grass-${color.toString(16)}`, "grass", {
    color,
    triplanar: { worldScale: 4, upBias: 1.8 },
  });
export const foliage = (color = 0xffffff) =>
  mat(`foliage-${color.toString(16)}`, "foliage", {
    color,
    triplanar: { worldScale: 1 },
  });
export const sand = () => mat("sand", "sand", { triplanar: { worldScale: 3, upBias: 1.6 } });
export const chainlink = () =>
  mat("chainlink", "chainlink", { triplanar: { worldScale: 1 } });

/**
 * The Palace of Fine Arts lagoon. Bay.tsx owns the ocean; this is a small,
 * still, enclosed body of water that would look wrong with a Gerstner swell on
 * it, so it borrows the wet-asphalt recipe — which is, physically, exactly
 * what a thin film of still water over a dark bed looks like — and tints it.
 */
export const stillWater = (color = 0x2a4a44) =>
  mat(`still-water-${color.toString(16)}`, "asphalt-wet", {
    color,
    triplanar: { worldScale: 11, upBias: 2.2, detailScale: 3 },
    envMapIntensity: 2.6,
  });

/* ------------------------------------------------------------------ *
 * Emitters
 * ------------------------------------------------------------------ */

const emitters = new Map<string, THREE.MeshStandardMaterial>();

/**
 * A self-lit surface: aircraft warning lights, the Salesforce crown, the
 * Alcatraz lantern, neon. Deliberately *not* a `MeshBasicMaterial` — these
 * still need to receive a little ambient so they do not punch a flat hole in
 * the fog at 4 km.
 */
export function emitter(
  color: THREE.ColorRepresentation,
  intensity = 4,
): THREE.MeshStandardMaterial {
  const key = `${new THREE.Color(color).getHexString()}|${intensity}`;
  const hit = emitters.get(key);
  if (hit) return hit;
  const m = new THREE.MeshStandardMaterial({
    color: 0x0a0a0a,
    emissive: new THREE.Color(color),
    emissiveIntensity: intensity,
    roughness: 0.4,
    metalness: 0,
    toneMapped: true,
    fog: true,
  });
  m.name = `sf/landmark/emitter-${key}`;
  emitters.set(key, m);
  return m;
}

/** Tear down the emitters this module owns. Library materials are shared. */
export function disposeLandmarkMaterials(): void {
  for (const m of emitters.values()) m.dispose();
  emitters.clear();
  cache.clear();
}
