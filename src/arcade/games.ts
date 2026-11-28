/**
 * The Vibe Arcade's scoring rules: which games keep a high score, which way a
 * score runs, how it is written on the wall, and how many tickets it pays.
 *
 * A game reports one number when a run ends (`report.ts`); everything else,
 * the wall, the tickets, whether you made the top ten, is decided here, so a
 * game never has to know it is in an arcade.
 */

export interface ArcadeGame {
  key: string;
  title: string;
  /** Short name for a column on the wall. */
  short: string;
  /** "desc": more is better. "asc": less is better (a time). */
  order: "desc" | "asc";
  /** How a score is written: plain points, or seconds as m:ss. */
  unit: "pts" | "time" | "len";
  /** The highest score the database will take, so a typo cannot top the wall forever. */
  max: number;
  /** Tickets for one run. */
  tickets(score: number, won: boolean): number;
  /** The machine's own names on the wall until real people beat them. */
  house: Array<[string, number]>;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(v)));

export const ARCADE_GAMES: ArcadeGame[] = [
  {
    key: "mortmaze", title: "Mort Maze", short: "MORT MAZE", order: "desc", unit: "pts", max: 5_000_000,
    tickets: (s) => clamp(3 + s / 600, 3, 40),
    house: [["MRT", 18_400], ["VBY", 12_250], ["LND", 8_900], ["GHO", 4_200], ["ZAP", 1_800]],
  },
  {
    key: "2048", title: "2048", short: "2048", order: "desc", unit: "pts", max: 10_000_000,
    tickets: (s) => clamp(3 + s / 700, 3, 40),
    house: [["TIL", 24_120], ["MRG", 16_480], ["VBY", 9_320], ["SLD", 5_100], ["TWO", 2_048]],
  },
  {
    key: "coil", title: "COIL", short: "COIL", order: "desc", unit: "len", max: 1_000_000,
    tickets: (s) => clamp(3 + s / 25, 3, 40),
    house: [["SSS", 640], ["NOM", 420], ["VBY", 310], ["WRM", 180], ["HSS", 90]],
  },
  {
    key: "boxing", title: "Haymaker Boxing", short: "HAYMAKER", order: "desc", unit: "pts", max: 100_000,
    tickets: (s, won) => clamp(2 + s / 40 + (won ? 10 : 0), 2, 40),
    house: [["KOK", 820], ["JAB", 610], ["VBY", 455], ["HOO", 300], ["DUK", 150]],
  },
  {
    key: "hoops", title: "Vibe Hoops", short: "HOOPS", order: "desc", unit: "pts", max: 1_000,
    tickets: (s, won) => clamp(2 + s / 3 + (won ? 10 : 0), 2, 40),
    house: [["DNK", 42], ["SWS", 35], ["VBY", 28], ["BRK", 21], ["AIR", 14]],
  },
  {
    key: "pool", title: "8-Ball Club", short: "8-BALL", order: "desc", unit: "pts", max: 10_000,
    tickets: (s, won) => clamp(2 + s / 40 + (won ? 8 : 0), 2, 40),
    house: [["CUE", 470], ["RCK", 380], ["VBY", 260], ["BNK", 160], ["CHK", 60]],
  },
  {
    key: "vibecup", title: "Vibe Cup", short: "VIBE CUP", order: "desc", unit: "pts", max: 100_000,
    tickets: (s, won) => clamp(2 + s / 60 + (won ? 8 : 0), 2, 40),
    house: [["GOL", 900], ["NUT", 650], ["VBY", 450], ["KCK", 300], ["OFF", 100]],
  },
  {
    key: "solitaire", title: "Solitaire", short: "SOLITAIRE", order: "asc", unit: "time", max: 36_000,
    tickets: (s) => clamp(30 - s / 20, 8, 30),
    house: [["ACE", 142], ["KNG", 205], ["VBY", 268], ["QUN", 340], ["JAK", 455]],
  },
];

export const arcadeGame = (key: string): ArcadeGame | undefined => ARCADE_GAMES.find((g) => g.key === key);

export function formatScore(g: ArcadeGame | undefined, score: number): string {
  if (!g) return score.toLocaleString();
  if (g.unit === "time") {
    const m = Math.floor(score / 60);
    const s = Math.floor(score % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
  }
  return score.toLocaleString();
}

/** True when `a` beats `b` on this game's scale. */
export const beats = (g: ArcadeGame, a: number, b: number) => (g.order === "desc" ? a > b : a < b);

/**
 * Three letters for the wall. Upper-case letters and digits only, and a short
 * list of words that do not belong on an arcade wall a kid walks past.
 */
const BLOCKED = new Set(["ASS", "FUK", "FUC", "FCK", "SEX", "CUM", "TIT", "DIK", "DIC", "COK", "KKK", "NIG", "FAG", "JIZ", "WTF", "STD", "POO", "PEE", "XXX", "NAZ", "HTL"]);
export function cleanInitials(raw: string): string | null {
  const s = raw.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 3);
  if (s.length !== 3 || BLOCKED.has(s)) return null;
  return s;
}
