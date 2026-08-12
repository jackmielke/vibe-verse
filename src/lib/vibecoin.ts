/**
 * Vibey Coins — the play currency of the vibeverse, in one module.
 *
 * Before this file, "how many coins does this person have" was answered four
 * different ways. Vibe City kept a number in a ref and mirrored it into
 * localStorage. The sky-island games minted through `vibeEconomy.gameReward`
 * and then *also* updated the city's local number. `/coin` read an ERC-20
 * balance off Base and had no idea the ledger existed. Nothing in the nav knew
 * about any of it, so a visitor could earn 90 ✦ on a floating island and see no
 * evidence of it anywhere else in the app.
 *
 * This is the one place that answers the question, and everything that shows a
 * balance subscribes to it. Add a world that pays out, call `award()`, and the
 * number in the top-right corner ticks up while you are still standing in the
 * world that paid you.
 *
 * ## Two coins, two names, and why that matters more than it sounds
 *
 * For most of this project both things were called "Vibecoin", which made
 * every sentence about either of them ambiguous — including in the UI, where
 * a visitor could not tell whether the number in the corner was money. They
 * have separate names now:
 *
 *   - **Vibey Coins** ✦ (this module). Rows in `vibe_balances` /
 *     `vibe_ledger`, written only by the `vibe-economy` edge function.
 *     Everyone has some, signed in or not, and it starts at 100. This is what
 *     you earn in worlds and spend in the arcade. It is *not* on a blockchain
 *     and does not claim to be. Named after Vibey, who hands them out.
 *   - **Vibecoin / $VIBE** (`src/lib/vibe-wallet.ts`). A real ERC-20 at
 *     `0x7255…a7d1`, on Base, in a wallet you control. Marked with the wink
 *     rather than the ✦ — see `VibeWink`.
 *
 * They are deliberately kept apart. Vibey Coins can be generous, reversible
 * and played with; the token cannot. The bridge between them — earn the play
 * coin, claim the real one — is a decision with real money on the other side
 * of it, and `vibe-drop` is the only thing in the codebase that crosses it.
 * See `docs/VIBECOIN.md`.
 *
 * ## Offline is a normal state, not an error
 *
 * Someone is standing in a world with a canvas running at 60fps. Supabase being
 * unreachable must not blank the number in their corner, and must not throw
 * into a render. So every read falls back to the last value we cached in
 * localStorage, every write is optimistic, and every failure resolves rather
 * than rejects. A wrong-by-a-few balance that keeps working beats a correct one
 * that disappears.
 */
import { supabase } from "@/integrations/supabase/client";
import { celebrate } from "@/lib/celebrate";

// ---------------------------------------------------------------------------
// Brand
// ---------------------------------------------------------------------------

/**
 * The glyph. `✦` and not `◈` or `$` because the sky-island games and SnackFe in
 * Vibe City have been printing `✦` at players for months — the currency already
 * had a symbol in the only place it was visible, and picking a prettier one now
 * would mean the coins in the corner and the coins in the world look like two
 * different currencies.
 */
export const VIBECOIN_GLYPH = "✦";
/**
 * What the play coin is called, everywhere it is named.
 *
 * "Vibey Coins", not "Vibecoin" — the real ERC-20 is Vibecoin, and having one
 * word for both is how you get a player who thinks the number in the corner
 * is money, or one who thinks the token is a score. The ✦ marks this one and
 * the wink marks the token; the names now match the marks.
 */
export const VIBECOIN_NAME = "Vibey Coins";
/** Singular, for "one Vibey Coin" rather than "one Vibey Coins". */
export const VIBECOIN_NAME_ONE = "Vibey Coin";
/** Plural-safe short form, for "12 VC" style captions. */
export const VIBECOIN_SHORT = "VC";

/**
 * Everyone starts here. Mirrors `STARTER_BALANCE` in the edge function, which
 * is the authority — this copy exists so a first-time visitor who is offline
 * still sees a plausible number instead of a dash.
 */
export const VIBECOIN_STARTER = 100;

/**
 * Format a balance for display. Compact above 10,000 because the nav chip is
 * about eleven characters wide and "1,284,300" in it is not a design.
 */
export function formatVibecoin(n: number, opts: { compact?: boolean } = {}): string {
  const v = Number.isFinite(n) ? n : 0;
  const compact = opts.compact ?? true;
  if (compact && Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (compact && Math.abs(v) >= 10_000) return `${(v / 1_000).toFixed(1)}K`;
  // Whole coins read as whole coins. The ledger stores 2dp because agent shops
  // price things at 12.5, and "1,240.00" everywhere is noise.
  return Number.isInteger(v) ? v.toLocaleString() : v.toFixed(2);
}

// ---------------------------------------------------------------------------
// Who the wallet belongs to
// ---------------------------------------------------------------------------

/**
 * The localStorage key holding the anonymous player's id.
 *
 * It is named `city.guestId` because Vibe City minted it first, and there are
 * real balances in production keyed to it. Renaming the key would orphan every
 * guest wallet that exists, so the name stays wrong and this comment explains
 * why. Read it as "the vibeverse guest id" everywhere outside this file.
 */
const GUEST_KEY = "city.guestId";

/** Last known balance, so the chip has something to draw before the network answers. */
const CACHE_KEY = "vibe.coin.cache.v1";

/** Stable anonymous id, minted on first read and never rotated. */
export function guestId(): string {
  if (typeof localStorage === "undefined") return "guest-ssr";
  let id = localStorage.getItem(GUEST_KEY);
  if (!id) {
    id =
      crypto.randomUUID?.() ??
      `guest-${Math.random().toString(36).slice(2)}-${Date.now()}`;
    localStorage.setItem(GUEST_KEY, id);
  }
  return id;
}

export interface Owner {
  kind: "user";
  ref: string;
}

/**
 * Whose wallet this browser is looking at.
 *
 * Signing in does not merge a guest wallet into an account — the two are
 * separate rows, and pretending otherwise would silently double or destroy
 * someone's balance depending on which way we merged. Signed-in players get
 * their own wallet, seeded with the same 100, and the guest wallet stays put in
 * case they sign out again. Merging is a product decision for later; see
 * `docs/VIBECOIN.md`.
 */
export async function currentOwner(): Promise<Owner> {
  try {
    const { data } = await supabase.auth.getSession();
    const uid = data.session?.user?.id;
    if (uid) return { kind: "user", ref: uid };
  } catch {
    /* Auth unreachable — fall through to the guest wallet. */
  }
  return { kind: "user", ref: guestId() };
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export interface LedgerEntry {
  id: string;
  amount: number;
  reason: string;
  memo: string | null;
  /** Signed from *this* wallet's point of view: +earned, −spent. */
  delta: number;
  created_at: string | null;
}

export interface VibecoinState {
  /** null means "we have genuinely never seen a number", which renders as `—`. */
  balance: number | null;
  ledger: LedgerEntry[];
  /** A fetch is in flight. */
  loading: boolean;
  /** The last fetch failed and we are showing a cached or optimistic figure. */
  stale: boolean;
}

type Listener = (s: VibecoinState) => void;

function readCache(): number | null {
  if (typeof localStorage === "undefined") return null;
  const raw = localStorage.getItem(CACHE_KEY);
  const n = raw == null ? NaN : Number(raw);
  return Number.isFinite(n) ? n : null;
}

function writeCache(n: number): void {
  try {
    localStorage.setItem(CACHE_KEY, String(n));
  } catch {
    /* Private mode, quota, a browser with storage switched off. Not fatal. */
  }
}

let state: VibecoinState = {
  balance: readCache(),
  ledger: [],
  loading: false,
  stale: false,
};

const listeners = new Set<Listener>();

function set(patch: Partial<VibecoinState>): void {
  const was = state.balance;
  state = { ...state, ...patch };
  if (typeof patch.balance === "number") writeCache(patch.balance);
  /**
   * The balance went up, so something good happened — say so once, here.
   *
   * Every path that pays out already funnels through this one function: arcade
   * payouts, the daily grant, portal awards, the optimistic bump, and the
   * plain refresh that first notices a payout made in another tab. Emitting
   * from each of them instead would be five call sites and a sixth one missed
   * the next time somebody adds a way to earn.
   *
   * A *fall* is deliberately silent. Spending is a thing you chose; it does
   * not need the logo to do a lap about it.
   */
  if (typeof patch.balance === "number" && was != null && patch.balance > was) {
    celebrate("vibecoin", patch.balance - was);
  }
  for (const l of listeners) l(state);
}

export function getVibecoinState(): VibecoinState {
  return state;
}

export function subscribeVibecoin(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

// ---------------------------------------------------------------------------
// Talking to the ledger
// ---------------------------------------------------------------------------

/**
 * Every write goes through the `vibe-economy` edge function, which holds the
 * service-role key. Nothing in the browser can move a balance directly — the
 * RLS on `vibe_balances` sees to that — so a cheat has to beat the server's own
 * clamps rather than a client-side check.
 */
async function call<T>(action: string, payload: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke("vibe-economy", {
    body: { action, ...payload },
  });
  if (error) throw new Error(error.message);
  if (!data?.ok) throw new Error(data?.error ?? "vibe-economy error");
  return data.data as T;
}

interface WalletRow {
  balance: number;
  ledger: Array<{
    id: string;
    from_kind: string | null;
    from_ref: string | null;
    to_kind: string | null;
    to_ref: string | null;
    amount: number;
    reason: string;
    memo: string | null;
    created_at: string | null;
  }>;
}

/**
 * Pull the authoritative balance and the last twenty movements.
 *
 * Resolves either way. A rejected promise here would have to be caught at every
 * call site — including inside `useEffect`s in worlds that are mid-render — and
 * the one place that genuinely needs to know it failed is the `stale` flag.
 */
export async function refreshVibecoin(): Promise<number | null> {
  set({ loading: true });
  try {
    const owner = await currentOwner();
    const w = await call<WalletRow>("wallet", {
      ownerKind: owner.kind,
      ownerRef: owner.ref,
    });
    const ledger: LedgerEntry[] = (w.ledger ?? []).map((r) => {
      const mine = r.to_kind === owner.kind && r.to_ref === owner.ref;
      return {
        id: r.id,
        amount: Number(r.amount),
        reason: r.reason,
        memo: r.memo,
        delta: mine ? Number(r.amount) : -Number(r.amount),
        created_at: r.created_at,
      };
    });
    set({ balance: Number(w.balance), ledger, loading: false, stale: false });
    return state.balance;
  } catch {
    set({ loading: false, stale: true });
    return state.balance;
  }
}

/**
 * Nudge the local number without waiting for a round trip.
 *
 * Used the moment a coin is inserted or a payout lands, so the chip in the
 * corner moves on the same frame as the sound effect. The next `refresh()`
 * overwrites it with the truth; until then the player sees the number they
 * expect rather than the number from before their last action.
 */
export function applyLocalDelta(delta: number): void {
  const base = state.balance ?? VIBECOIN_STARTER;
  set({ balance: Math.max(0, Math.round((base + delta) * 100) / 100) });
}

/**
 * Mint for a world's mini-game. The amount is decided server-side from the
 * game key and the score — the client says "I scored 34 at mole-meadow", never
 * "pay me 68".
 */
export async function award(
  game: string,
  score: number,
): Promise<{ amount: number; balance: number; capped: boolean; playsLeft: number | null } | null> {
  try {
    const owner = await currentOwner();
    const r = await call<{
      amount: number;
      balance: number;
      capped: boolean;
      playsLeft: number | null;
    }>("game_reward", { ownerKind: owner.kind, ownerRef: owner.ref, game, score });
    set({ balance: Number(r.balance), stale: false });
    void refreshVibecoin();
    return r;
  } catch {
    set({ stale: true });
    return null;
  }
}

// ---------------------------------------------------------------------------
// The arcade: pay to play, settle to win
// ---------------------------------------------------------------------------

export interface ArcadePlay {
  /** The debit's ledger row id. Settling quotes it, and a row settles once. */
  playId: string;
  /** What the coin cost, as charged. */
  cost: number;
  balance: number;
}

export interface ArcadeSettlement {
  amount: number;
  balance: number;
  /** True when the daily payout ceiling swallowed part or all of the win. */
  capped: boolean;
  /** Winnings still available today, after this settlement. */
  remainingToday: number;
}

/**
 * Insert a coin. Debits the stake and hands back a play id.
 *
 * This throws where everything else in this module swallows, and that is on
 * purpose: "you could not pay for this game" is the one failure the player has
 * to be told about, because the alternative is a cabinet that starts, plays,
 * and then cannot pay out.
 */
export async function arcadeInsert(game: string): Promise<ArcadePlay> {
  const owner = await currentOwner();
  const r = await call<ArcadePlay>("arcade_insert", {
    ownerKind: owner.kind,
    ownerRef: owner.ref,
    game,
  });
  set({ balance: Number(r.balance), stale: false });
  return r;
}

/**
 * The daily allowance — the arcade's one faucet.
 *
 * Without it the economy has a dead end: spend your hundred, lose every run,
 * and the arcade is a room full of machines you cannot use, forever. That is
 * a fine rule for a casino and a terrible one for a place people are meant to
 * come back to. Once a day, if you are nearly broke, the machine tops you up
 * to enough for a few plays. The server decides both the threshold and the
 * once-a-day part; this just asks.
 */
export async function arcadeAllowance(): Promise<{
  granted: number;
  balance: number;
  nextAt: string | null;
} | null> {
  try {
    const owner = await currentOwner();
    const r = await call<{ granted: number; balance: number; nextAt: string | null }>(
      "arcade_allowance",
      { ownerKind: owner.kind, ownerRef: owner.ref },
    );
    set({ balance: Number(r.balance), stale: false });
    void refreshVibecoin();
    return r;
  } catch {
    set({ stale: true });
    return null;
  }
}

/**
 * Cash out a finished run. The payout curve lives on the server; this reports
 * the score and the play id and takes what it is given.
 */
export async function arcadeSettle(
  playId: string,
  game: string,
  score: number,
): Promise<ArcadeSettlement | null> {
  try {
    const owner = await currentOwner();
    const r = await call<ArcadeSettlement>("arcade_settle", {
      ownerKind: owner.kind,
      ownerRef: owner.ref,
      playId,
      game,
      score,
    });
    set({ balance: Number(r.balance), stale: false });
    void refreshVibecoin();
    return r;
  } catch {
    set({ stale: true });
    return null;
  }
}
