export interface SkyRider { id: string; name: string; x: number; y: number; z: number; playing: boolean; }
export interface SkyTag { from: string; to: string; at: number; }
export const SKY_TAG_RADIUS = 6;
export const SKY_TAG_COOLDOWN = 3000;
export function initialTagger(riders: SkyRider[]): string | null {
  const ids = riders.filter(r => r.playing).map(r => r.id).sort();
  return ids.length >= 2 ? ids[0] : null;
}
export function canSkyTag(a: SkyRider, b: SkyRider, now: number, lastAt: number): boolean {
  return a.id !== b.id && a.playing && b.playing && now - lastAt >= SKY_TAG_COOLDOWN &&
    Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) <= SKY_TAG_RADIUS;
}
export function acceptSkyTag(current: SkyTag | null, next: SkyTag): SkyTag | null {
  if (!Number.isFinite(next.at) || !next.from || !next.to || next.from === next.to) return current;
  if (!current || next.at > current.at || (next.at === current.at && next.from < current.from)) return next;
  return current;
}