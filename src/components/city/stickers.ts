/** Body stickers — pure rules (no three.js). A sticker is an emoji stamp at a named body spot. */
export const STICKER_ART = ["⭐", "🔥", "💜", "⚡", "🌈", "💀", "🌸", "👑", "🪙", "😎", "🦄", "🍄"] as const;
export type StickerSlot = "chest" | "back" | "head" | "belly" | "armL" | "armR";
export const STICKER_SLOTS: { id: StickerSlot; label: string }[] = [
  { id: "chest", label: "Chest" },
  { id: "belly", label: "Belly" },
  { id: "back", label: "Back" },
  { id: "head", label: "Head" },
  { id: "armL", label: "Left arm" },
  { id: "armR", label: "Right arm" },
];
export interface Sticker { art: string; slot: StickerSlot }
export const MAX_STICKERS = 6;

/** Accepts anything off the wire; returns at most one sticker per slot, known art only. */
export function sanitizeStickers(raw: unknown): Sticker[] {
  if (!Array.isArray(raw)) return [];
  const slots = new Set(STICKER_SLOTS.map((s) => s.id));
  const out = new Map<StickerSlot, Sticker>();
  for (const r of raw) {
    const s = r as Partial<Sticker>;
    if (typeof s?.art !== "string" || !(STICKER_ART as readonly string[]).includes(s.art)) continue;
    if (!slots.has(s.slot as StickerSlot)) continue;
    out.set(s.slot as StickerSlot, { art: s.art, slot: s.slot as StickerSlot });
  }
  return [...out.values()].slice(0, MAX_STICKERS);
}

/** Placing on an occupied slot replaces what was there. */
export function placeSticker(list: Sticker[], next: Sticker): Sticker[] {
  return sanitizeStickers([...list.filter((s) => s.slot !== next.slot), next]);
}

/** Where a slot sits as fractions of the body's box: x/y in [0,1], face +1 front / -1 back / 0 side. */
export const SLOT_PLACE: Record<StickerSlot, { fx: number; fy: number; face: number; size: number }> = {
  chest: { fx: 0.5, fy: 0.68, face: 1, size: 0.22 },
  belly: { fx: 0.5, fy: 0.5, face: 1, size: 0.18 },
  back: { fx: 0.5, fy: 0.62, face: -1, size: 0.3 },
  head: { fx: 0.5, fy: 0.9, face: 1, size: 0.14 },
  armL: { fx: 0.9, fy: 0.62, face: 0, size: 0.12 },
  armR: { fx: 0.1, fy: 0.62, face: 0, size: 0.12 },
};
