/**
 * The interface's view of the weapon registry.
 *
 * The registry is the authority on ballistics; the HUD needs a much smaller
 * set of facts — what the reticle looks like, which glyph goes on the wheel,
 * how the magazine should be drawn. Rather than teach the registry about
 * pixels, the mapping lives here, keyed by the registry's own weapon keys.
 *
 * Every lookup is defensive. If a weapon key ever exists that this table has
 * not heard of, it gets a sane rifle-ish reticle and its registry name, and
 * the HUD carries on. A missing icon must never be a crash.
 */
import { WEAPONS, WEAPON_ORDER } from "../weapons/registry";

/**
 * Reticle families. These are visual archetypes, not weapon classes — a
 * grenade launcher and an RPG share brackets even though they behave
 * differently, because the player reads "this is an area weapon".
 */
export type ReticleKind =
  | "cross" // four ticks + centre gap: everything automatic
  | "duplex" // fine cross with a centre dot: precision semi-autos
  | "pellet" // four arcs on a circle: shotguns, sized to the true cone
  | "scope" // hairline cross, disappears into the optic under ADS
  | "bracket" // corner brackets + dot: launchers
  | "lob" // dot with a descending arc: thrown weapons
  | "none";

export interface WeaponUi {
  key: string;
  /** Full name for the wheel and pickup toasts. */
  name: string;
  /** 3-6 char abbreviation for the ammo block. */
  short: string;
  /** Registry class, used for grouping in the wheel. */
  cls: string;
  reticle: ReticleKind;
  /** Magazine capacity, for the pip strip. */
  magazine: number;
  /**
   * Above this pip count the magazine is drawn as a segmented bar rather than
   * discrete rounds — 200 individual pips is noise, not information.
   */
  pipLimit: number;
  /** Designer blurb shown in the weapon wheel. */
  blurb: string;
  /** Slot index, 1-based; matches the number-row keys. */
  slot: number;
  /** Simple SVG path (24x24 viewBox) used as the wheel + feed icon. */
  icon: string;
}

/* 24×24 silhouettes. Deliberately schematic — at 28px on a wheel a detailed
 * gun reads as a smudge, while a strong profile reads instantly. */
const ICONS = {
  pistol: "M4 9h9l2 3h4v2h-3l-1 4h-4l1-4H8v3H5v-3H4z",
  smg: "M3 8h13v3h3v2h-4l-1 2h-3l-1 4h-3l1-4H6v2H4v-2H3z",
  rifle: "M2 9h16l3 1v2h-4l-1 2h-4v3h-3v-3H6v2H4v-2H2z",
  battle: "M2 9h15l4 1v2h-5l-1 2h-3l-1 4h-3l1-4H6v2H4v-2H2z",
  shotgun: "M2 9h19v2H15l-1 2h-3v3H8v-3H5v2H3v-2H2z",
  sniper: "M2 10h4V8h4v2h11v2h-5l-1 2h-4v3h-3v-3H7v2H5v-2H2z",
  lmg: "M2 8h14v2h5v3h-4l-1 2h-3v4H8l1-4H6v2H4v-2H2zM6 13h4v4H6z",
  launcher: "M2 10h17l3 2-3 2H12l-2 3H6l2-3H2zM15 7h4v3h-4z",
  rocket: "M3 11h13l2-4 2 4-2 4-2-4H3zM6 13h5v3H6z",
  sticky: "M12 4a5 5 0 015 5c0 3-2 4-2 7H9c0-3-2-4-2-7a5 5 0 015-5zM9 18h6v2H9z",
  grenade: "M12 5a6 6 0 016 6 6 6 0 01-6 6 6 6 0 01-6-6 6 6 0 016-6zM10 3h4v3h-4zM15 3l3-1v3z",
} as const;

/** Per-key overrides. Anything absent falls back to the class table. */
const TABLE: Record<string, Partial<WeaponUi>> = {
  sidearm: { reticle: "duplex", icon: ICONS.pistol, pipLimit: 20 },
  smg: { reticle: "cross", icon: ICONS.smg, pipLimit: 45 },
  rifle: { reticle: "cross", icon: ICONS.rifle, pipLimit: 40 },
  battle: { reticle: "duplex", icon: ICONS.battle, pipLimit: 30 },
  shotgun: { reticle: "pellet", icon: ICONS.shotgun, pipLimit: 12 },
  sniper: { reticle: "scope", icon: ICONS.sniper, pipLimit: 12 },
  lmg: { reticle: "cross", icon: ICONS.lmg, pipLimit: 0 },
  gl: { reticle: "bracket", icon: ICONS.launcher, pipLimit: 12 },
  rpg: { reticle: "bracket", icon: ICONS.rocket, pipLimit: 6 },
  sticky: { reticle: "lob", icon: ICONS.sticky, pipLimit: 8 },
  grenade: { reticle: "lob", icon: ICONS.grenade, pipLimit: 6 },
};

const BY_CLASS: Record<string, { reticle: ReticleKind; icon: string }> = {
  sidearm: { reticle: "duplex", icon: ICONS.pistol },
  smg: { reticle: "cross", icon: ICONS.smg },
  rifle: { reticle: "cross", icon: ICONS.rifle },
  battle: { reticle: "duplex", icon: ICONS.battle },
  shotgun: { reticle: "pellet", icon: ICONS.shotgun },
  sniper: { reticle: "scope", icon: ICONS.sniper },
  lmg: { reticle: "cross", icon: ICONS.lmg },
  launcher: { reticle: "bracket", icon: ICONS.launcher },
  rocket: { reticle: "bracket", icon: ICONS.rocket },
  sticky: { reticle: "lob", icon: ICONS.sticky },
  thrown: { reticle: "lob", icon: ICONS.grenade },
};

const cache = new Map<string, WeaponUi>();

/** UI descriptor for a weapon key. Memoised; safe to call per frame. */
export function weaponUi(key: string): WeaponUi {
  const hit = cache.get(key);
  if (hit) return hit;

  const def = (WEAPONS as Record<string, unknown>)[key] as
    | {
        name?: string;
        short?: string;
        cls?: string;
        magazine?: number;
        blurb?: string;
      }
    | undefined;
  const cls = def?.cls ?? "rifle";
  const fallback = BY_CLASS[cls] ?? BY_CLASS.rifle;
  const over = TABLE[key] ?? {};

  const out: WeaponUi = {
    key,
    name: def?.name ?? key.toUpperCase(),
    short: def?.short ?? key.slice(0, 4).toUpperCase(),
    cls,
    reticle: over.reticle ?? fallback.reticle,
    magazine: def?.magazine ?? 30,
    pipLimit: over.pipLimit ?? 40,
    blurb: def?.blurb ?? "",
    slot: Math.max(1, WEAPON_ORDER.indexOf(key) + 1),
    icon: over.icon ?? fallback.icon,
  };
  cache.set(key, out);
  return out;
}

/** Wheel order — registry order, which is also the number-key order. */
export const WHEEL_ORDER: readonly string[] = WEAPON_ORDER;

/**
 * Reticle geometry driven by the live cone.
 *
 * The gap between the reticle's arms is the *actual* projected cone at the
 * screen's centre, so a player can read their accuracy off the crosshair
 * instead of memorising which stance costs how much. `spreadDeg` is the half
 * angle; the screen half-height in pixels for a given vertical FOV gives the
 * pixels-per-degree conversion.
 */
export function spreadToPixels(spreadDeg: number, fovDeg: number, viewportH: number): number {
  const halfFov = (fovDeg * 0.5 * Math.PI) / 180;
  const pxPerTan = viewportH * 0.5 / Math.tan(halfFov);
  return pxPerTan * Math.tan((spreadDeg * Math.PI) / 180);
}
