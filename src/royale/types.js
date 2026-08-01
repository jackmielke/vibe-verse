/** The build grid, in metres. Everything structural is a multiple of this. */
export const GRID = 4;
/** Wall thickness for built pieces. */
export const WALL_THICKNESS = 0.25;
/** Canonical rarity colours. Loot beams, item cards and the HUD all use these. */
export const RARITY_COLOR = {
    common: 0xb1b1b1,
    uncommon: 0x53d24a,
    rare: 0x4c8bf5,
    epic: 0xb455f0,
    legendary: 0xf2a93b,
};
/** Mulberry32 — small, fast, seedable. Keeps worldgen reproducible. */
export function makeRng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
