/**
 * Vibeverse portal protocol.
 *
 * Inbound: another world sends players here with `?portal=true&username=…&ref=…`
 * plus optional avatar/loadout hints. We skip the menus, spawn them at the
 * arrival portal, and remember `ref` so the return portal sends them home.
 *
 * Outbound: walking into the exit portal navigates to the Vibeverse hub with
 * our own URL as `ref`, carrying the player's identity forward.
 */

export const VIBEVERSE_HUB = "http://portal.pieter.com/";

export interface VibeverseEntry {
  /** true when the player arrived through a portal */
  arrived: boolean;
  username: string;
  color: string;
  speed: number;
  /** the world that sent them here — where the return portal points */
  ref: string | null;
  avatar: string | null;
  team: string | null;
  meta: Record<string, string>;
}

const DEFAULTS: VibeverseEntry = {
  arrived: false,
  username: "",
  color: "#12a5f5",
  speed: 1,
  ref: null,
  avatar: null,
  team: null,
  meta: {},
};

export function readEntry(): VibeverseEntry {
  if (typeof window === "undefined") return { ...DEFAULTS };
  const p = new URLSearchParams(window.location.search);
  const arrived = p.get("portal") === "true" || p.has("ref");
  if (!arrived) return { ...DEFAULTS };

  const meta: Record<string, string> = {};
  p.forEach((v, k) => {
    if (!["portal", "username", "color", "speed", "ref", "avatar", "team"].includes(k)) meta[k] = v;
  });

  return {
    arrived: true,
    username: p.get("username") || "Traveler",
    color: p.get("color") || DEFAULTS.color,
    speed: Number(p.get("speed") || 1) || 1,
    ref: p.get("ref"),
    avatar: p.get("avatar"),
    team: p.get("team"),
    meta,
  };
}

function normalizeRef(ref: string): string {
  if (/^https?:\/\//i.test(ref)) return ref;
  return `https://${ref}`;
}

/** Build the URL for the exit portal (onward to the Vibeverse hub). */
export function buildExitUrl(entry: VibeverseEntry, extra: Record<string, string> = {}): string {
  const url = new URL(VIBEVERSE_HUB);
  url.searchParams.set("portal", "true");
  url.searchParams.set("username", entry.username || "Traveler");
  url.searchParams.set("color", entry.color);
  url.searchParams.set("speed", String(entry.speed));
  url.searchParams.set("ref", window.location.origin + window.location.pathname);
  Object.entries(extra).forEach(([k, v]) => url.searchParams.set(k, v));
  return url.toString();
}

/** Build the URL for the return portal (back where they came from). */
export function buildReturnUrl(entry: VibeverseEntry): string | null {
  if (!entry.ref) return null;
  const url = new URL(normalizeRef(entry.ref));
  url.searchParams.set("portal", "true");
  url.searchParams.set("username", entry.username || "Traveler");
  url.searchParams.set("color", entry.color);
  url.searchParams.set("speed", String(entry.speed));
  url.searchParams.set("ref", window.location.origin + window.location.pathname);
  return url.toString();
}

export function travel(url: string): void {
  window.location.href = url;
}
