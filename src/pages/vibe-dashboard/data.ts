/**
 * vibe-dashboard/data.ts — the STATIC side of the $VIBE dashboard.
 *
 * Everything in this file is hand-entered from Jack's notes (Jul 2026)
 * and is meant to be edited by hand. Anything the UI can't fetch live
 * falls back to these values and shows the "as of Jul 2026 — wire to
 * live source" marker so nobody mistakes a snapshot for a feed.
 */

/** Shown wherever a static value stands in for a live feed. */
export const STATIC_AS_OF = "as of Jul 2026 — wire to live source";

// ---------------------------------------------------------------------
// On-chain reference points (from notes; not fetched)
// ---------------------------------------------------------------------

/** Treasury / ops wallet from Jack's notes. */
export const TREASURY_ADDRESS = "0x7255EcF1020a95fEd5323dd4fEb23a54Ab1Aa7D1";

/** Jack's own $VIBE allocation, per notes ("50k+"). */
export const JACK_ALLOCATION_NOTE = "Jack's own allocation: 50k+ $VIBE";

/** Static market-cap fallback when GeckoTerminal is unreachable. */
export const STATIC_MARKET_CAP_USD = 90_000;

/**
 * The ONLY two market-cap points we actually know. This is sparse,
 * known data — the chart must present it as two labeled points, never
 * as a fabricated continuous history.
 */
export interface MarketCapPoint {
  label: string; // x-axis label
  usd: number;
  note: string;
}
export const MARKET_CAP_POINTS: MarketCapPoint[] = [
  { label: "Peak", usd: 1_500_000, note: "peak, exact date not recorded" },
  { label: "Jul 2026", usd: 90_000, note: "approximate, from notes" },
];

// ---------------------------------------------------------------------
// Buildathon payouts tracker — EDIT ME as payouts land.
// Terms per winner: $500-equivalent in $VIBE with a HODL-through-2026
// ask, or a $40 USD alternative for anyone who'd rather not hold.
// ---------------------------------------------------------------------

export type PayoutStatus = "paid" | "pending";
export type PayoutOption = "vibe-hodl" | "usd-alt" | "unchosen";

export interface BuildathonPayout {
  name: string;
  status: PayoutStatus;
  /** Which option they took (or "unchosen" while pending). */
  option: PayoutOption;
  note?: string;
}

export const PAYOUT_TERMS = {
  "vibe-hodl": "$500-equiv $VIBE · HODL thru 2026",
  "usd-alt": "$40 USD alt",
  unchosen: "choice pending",
} as const;

export const BUILDATHON_PAYOUTS: BuildathonPayout[] = [
  { name: "Miss Purple", status: "paid", option: "vibe-hodl" },
  { name: "Yudhishthra", status: "paid", option: "vibe-hodl" },
  { name: "Brennan", status: "pending", option: "unchosen" },
  { name: "Tomas", status: "pending", option: "unchosen" },
  { name: "Josh", status: "pending", option: "unchosen" },
  { name: "Colton", status: "pending", option: "unchosen" },
  { name: "Myco", status: "pending", option: "unchosen" },
  { name: "Shaka", status: "pending", option: "unchosen" },
  { name: "Navo", status: "pending", option: "unchosen" },
  { name: "Ana", status: "pending", option: "unchosen" },
  { name: "Noah", status: "pending", option: "unchosen" },
];

// ---------------------------------------------------------------------
// Fallback in-app economy snapshot — mirrors what the live tables held
// in Jul 2026 so the fallback UI looks like the real thing, clearly
// marked as a snapshot. Used ONLY when Supabase reads fail.
// ---------------------------------------------------------------------

export interface HolderRow {
  ownerKind: "user" | "agent";
  ownerRef: string;
  balance: number;
  /** Display name (agent name when public; short ref for users). */
  name: string;
}

export interface LedgerRow {
  id: string;
  amount: number;
  reason: string;
  memo: string | null;
  fromKind: string | null;
  toKind: string | null;
  toName: string;
  createdAt: string;
}

export const FALLBACK_HOLDERS: HolderRow[] = [
  { ownerKind: "user", ownerRef: "5848d30b", balance: 116, name: "user 5848…30b" },
  { ownerKind: "user", ownerRef: "aedb1ad1", balance: 100, name: "user aedb…ad1" },
  { ownerKind: "agent", ownerRef: "7a5f173c", balance: 76, name: "Edge (agent)" },
  { ownerKind: "user", ownerRef: "18f08f2d", balance: 74, name: "user 18f0…f2d" },
  { ownerKind: "agent", ownerRef: "8092bfc3", balance: 50, name: "agent 8092…fc3" },
  { ownerKind: "agent", ownerRef: "c2b2e9c8", balance: 50, name: "agent c2b2…9c8" },
  { ownerKind: "agent", ownerRef: "08efa889", balance: 50, name: "agent 08ef…889" },
  { ownerKind: "agent", ownerRef: "03eacdaa", balance: 50, name: "agent 03ea…daa" },
  { ownerKind: "agent", ownerRef: "52fe69e7", balance: 50, name: "agent 52fe…9e7" },
];

export const FALLBACK_LEDGER: LedgerRow[] = [
  { id: "f1", amount: 50, reason: "starter", memo: "welcome to the vibeverse", fromKind: "system", toKind: "agent", toName: "agent c2b2…9c8", createdAt: "2026-07-09T20:10:14Z" },
  { id: "f2", amount: 16, reason: "game_reward", memo: "shrine-dive · score 16", fromKind: "system", toKind: "user", toName: "user 5848…30b", createdAt: "2026-07-02T05:00:47Z" },
  { id: "f3", amount: 100, reason: "starter", memo: "welcome to the vibeverse", fromKind: "system", toKind: "user", toName: "user 5848…30b", createdAt: "2026-07-02T05:00:47Z" },
  { id: "f4", amount: 100, reason: "starter", memo: "welcome to the vibeverse", fromKind: "system", toKind: "user", toName: "user aedb…ad1", createdAt: "2026-06-29T22:51:38Z" },
  { id: "f5", amount: 26, reason: "item", memo: "Edge sticker pack", fromKind: "user", toKind: "agent", toName: "Edge (agent)", createdAt: "2026-06-29T03:05:42Z" },
  { id: "f6", amount: 50, reason: "starter", memo: "welcome to the vibeverse", fromKind: "system", toKind: "agent", toName: "Edge (agent)", createdAt: "2026-06-29T02:57:51Z" },
];

// ---------------------------------------------------------------------
// Chart palette — validated (dataviz six checks, dark surface #152132):
// lightness band, chroma floor, CVD separation, contrast all PASS.
// Color follows the entity kind, never rank.
// ---------------------------------------------------------------------

export const CHART_COLORS = {
  user: "#0D9C6B", // mint — community members
  agent: "#5680E0", // periwinkle — world agents
  treasury: "#B8862B", // amber — treasury / static figures
} as const;
