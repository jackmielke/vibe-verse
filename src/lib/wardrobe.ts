/**
 * The wardrobe — what you own, and what you are wearing, as facts about a
 * person rather than about a browser.
 *
 * ## What was wrong
 *
 * Hats, jetpack flames and jetpack shells already had prices printed on them —
 * 25 for the cap, 250 for the crown, 400 for the halo — and nothing had ever
 * charged one. The catalog comment said "currently free during early access",
 * ownership was an array in `localStorage`, and the three equipped ids were
 * three more `localStorage` keys. So the only currency *sink* the vibeverse had
 * was switched off, and the only thing resembling a personal possession
 * evaporated when you cleared your browser or opened the app on your phone.
 *
 * So ownership moved to the ledger. `vibe_inventory` holds what you bought,
 * `vibe_loadout` holds what you have on, and both are written only by the
 * `vibe-economy` edge function — a browser that could write its own inventory
 * row could give itself a crown for nothing.
 *
 * ## Why localStorage is still here
 *
 * It is a **cache, not a source of truth**, and that distinction is the whole
 * design. A world builds its player model on the frame it mounts; it cannot
 * wait on a round trip, and it must not render a bare head because someone's
 * wifi dropped in a tunnel. So every read answers instantly from the last
 * known loadout and reconciles when the server replies.
 *
 * The old keys (`city.hat`, `city.flame`, `city.jetpack`, `city.unlockedHats`)
 * are read on first run and never written again — see `adoptLegacy()`. People
 * who already picked a hat keep it.
 */
import { supabase } from "@/integrations/supabase/client";
import { currentOwner, refreshVibecoin } from "@/lib/vibecoin";

export type CosmeticKind = "hat" | "flame" | "jetpack";

export interface Loadout {
  hat: string;
  flame: string;
  jetpack: string;
}

export const DEFAULT_LOADOUT: Loadout = { hat: "none", flame: "mint", jetpack: "stock" };

/** `hat:crown` — namespaced because "violet" is both a flame and a jetpack. */
export const itemKey = (kind: CosmeticKind, id: string) => `${kind}:${id}`;

// ---------------------------------------------------------------------------
// Local cache
// ---------------------------------------------------------------------------

const CACHE_KEY = "vibe.wardrobe.v1";
/** The pre-ledger keys. Read once so nobody loses the hat they already chose. */
const LEGACY = {
  hat: "city.hat",
  flame: "city.flame",
  jetpack: "city.jetpack",
  unlocked: "city.unlockedHats",
  adopted: "vibe.wardrobe.adopted",
};

interface Cached {
  owned: string[];
  loadout: Loadout;
}

function readCache(): Cached {
  if (typeof localStorage === "undefined") return { owned: [], loadout: { ...DEFAULT_LOADOUT } };
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Cached;
      return {
        owned: Array.isArray(p.owned) ? p.owned : [],
        loadout: { ...DEFAULT_LOADOUT, ...(p.loadout ?? {}) },
      };
    }
  } catch {
    /* Someone else's key, or half a write. Fall through to the legacy read. */
  }
  return adoptLegacy();
}

/**
 * First run after this shipped: pull the old localStorage keys forward.
 *
 * Only the *equipped* ids are worth adopting. The old unlock list is
 * deliberately NOT treated as ownership — it was written by an on-chain
 * purchase flow that nothing verified locally, and honouring it would hand a
 * free crown to anyone who had ever typed the key in by hand. The loadout is
 * harmless: the server re-checks ownership before it will equip anything.
 */
function adoptLegacy(): Cached {
  const out: Cached = { owned: [], loadout: { ...DEFAULT_LOADOUT } };
  if (typeof localStorage === "undefined") return out;
  try {
    out.loadout = {
      hat: localStorage.getItem(LEGACY.hat) || DEFAULT_LOADOUT.hat,
      flame: localStorage.getItem(LEGACY.flame) || DEFAULT_LOADOUT.flame,
      jetpack: localStorage.getItem(LEGACY.jetpack) || DEFAULT_LOADOUT.jetpack,
    };
    localStorage.setItem(LEGACY.adopted, "1");
  } catch {
    /* Storage off. Stock issue it is. */
  }
  return out;
}

function writeCache(c: Cached): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(c));
    /* Keep the old keys in step for one more release: City and Drop Zero read
       them directly in a few places that have not been migrated yet, and a
       half-migrated player wearing two different hats is worse than a
       duplicated write. */
    localStorage.setItem(LEGACY.hat, c.loadout.hat);
    localStorage.setItem(LEGACY.flame, c.loadout.flame);
    localStorage.setItem(LEGACY.jetpack, c.loadout.jetpack);
  } catch {
    /* Private mode or quota. The session still works; it just forgets. */
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface WardrobeState extends Cached {
  loading: boolean;
  /** The last fetch failed; `owned` is whatever we last knew. */
  stale: boolean;
}

let state: WardrobeState = { ...readCache(), loading: false, stale: false };
const listeners = new Set<(s: WardrobeState) => void>();

function set(patch: Partial<WardrobeState>): void {
  state = { ...state, ...patch };
  writeCache({ owned: state.owned, loadout: state.loadout });
  for (const l of listeners) l(state);
}

export const getWardrobeState = (): WardrobeState => state;

export function subscribeWardrobe(fn: (s: WardrobeState) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

async function call<T>(action: string, payload: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke("vibe-economy", {
    body: { action, ...payload },
  });
  if (error) throw new Error(error.message);
  if (!data?.ok) throw new Error(data?.error ?? "vibe-economy error");
  return data.data as T;
}

/** Pull the authoritative wardrobe. Resolves either way — see the header. */
export async function refreshWardrobe(): Promise<WardrobeState> {
  set({ loading: true });
  try {
    const owner = await currentOwner();
    const r = await call<{ owned: string[]; loadout: Loadout }>("wardrobe", {
      ownerKind: owner.kind,
      ownerRef: owner.ref,
    });
    set({
      owned: r.owned ?? [],
      loadout: { ...DEFAULT_LOADOUT, ...(r.loadout ?? {}) },
      loading: false,
      stale: false,
    });
  } catch {
    set({ loading: false, stale: true });
  }
  return state;
}

/** Do you own this? Anything priced 0 is stock issue and always yours. */
export function owns(kind: CosmeticKind, id: string, price: number): boolean {
  return price <= 0 || state.owned.includes(itemKey(kind, id));
}

/**
 * Buy one. Throws on failure, unlike most of this module — "you could not
 * afford that" is the one outcome the shop has to say out loud, because the
 * alternative is a button that looks like it worked.
 */
export async function buyCosmetic(
  kind: CosmeticKind,
  id: string,
): Promise<{ title: string; price: number }> {
  const owner = await currentOwner();
  const r = await call<{
    owned: string[];
    bought: { title: string; price: number };
  }>("buy_cosmetic", { ownerKind: owner.kind, ownerRef: owner.ref, kind, id });
  set({ owned: r.owned ?? state.owned, stale: false });
  void refreshVibecoin(); // the balance in the corner moves with the purchase
  return r.bought;
}

/**
 * Equip. Optimistic — the look changes on the same frame you tap it, because
 * waiting on a network round trip to put a hat on feels broken. The server
 * re-checks ownership and the next refresh corrects a rejection.
 */
export async function equip(patch: Partial<Loadout>): Promise<boolean> {
  const before = state.loadout;
  set({ loadout: { ...before, ...patch } });
  try {
    const owner = await currentOwner();
    const r = await call<{ loadout: Loadout }>("set_loadout", {
      ownerKind: owner.kind,
      ownerRef: owner.ref,
      ...patch,
    });
    set({ loadout: { ...DEFAULT_LOADOUT, ...r.loadout }, stale: false });
    return true;
  } catch {
    set({ loadout: before, stale: true });
    return false;
  }
}

// ---------------------------------------------------------------------------
// Guest → account
// ---------------------------------------------------------------------------

/** Remember which guest key we already tried, so a failure is not a loop. */
const CLAIM_TRIED = "vibe.guestClaim.tried.v1";

/**
 * Bring a guest wallet across the first time someone signs in.
 *
 * This is the fix for the oldest hole in the currency: the ledger is keyed by a
 * browser-local guest id *or* an auth id, never both, so signing in used to
 * move you to a fresh empty wallet while your coins sat on the old key
 * forever. Nothing merged them because nothing could — there was no moment at
 * which the app knew both keys belonged to one person. Signing in is that
 * moment, and this is called at it.
 *
 * Safe to call on every sign-in: the server keys the claim on the guest ref and
 * refuses a second one. The local marker just saves a pointless round trip.
 */
export async function claimGuestWallet(): Promise<{ claimed: number; itemsMoved: number } | null> {
  if (typeof localStorage === "undefined") return null;
  const guestRef = localStorage.getItem("city.guestId");
  if (!guestRef) return null;
  if (localStorage.getItem(CLAIM_TRIED) === guestRef) return null;

  try {
    const r = await call<{ claimed: number; itemsMoved: number }>("claim_guest", { guestRef });
    localStorage.setItem(CLAIM_TRIED, guestRef);
    void refreshVibecoin();
    void refreshWardrobe();
    return r;
  } catch {
    // Already claimed, or not signed in yet. Mark it either way — a wallet that
    // cannot be claimed will not become claimable by asking again.
    localStorage.setItem(CLAIM_TRIED, guestRef);
    return null;
  }
}
