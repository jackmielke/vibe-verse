/**
 * The wallet book — every address you have proved, not just the last one.
 *
 * ## What was wrong
 *
 * Linking wrote a single key, `vibe.payoutAddress.v1`, and overwrote it. So a
 * person with a MetaMask they have used for years and a Base Account they made
 * here last week could hold exactly one of them at a time, and the app's only
 * vocabulary for the other was "Create a Vibe Wallet" — an invitation to make
 * a *third*. That is precisely backwards: the more wallets somebody has, the
 * more the app insisted they had none.
 *
 * So: a list. Every address you have signed for stays in it, each remembering
 * which wallet proved it, and exactly one is marked as where a drop should go.
 *
 * ## Why this is local and the server only knows one
 *
 * `link-wallet` writes a single `wallet_address` on a `users` row, and that is
 * the right shape for what the server actually needs to answer: *where do we
 * send this person's tokens*. That question has one answer. The book is the
 * client's memory of the addresses you have proved so you can switch which one
 * is the answer without re-proving the others every time.
 *
 * Each entry was proved by a real signature at the moment it was added — the
 * book cannot invent one. Losing it costs a re-link, not money.
 */
import { getAddress, isAddress, type Address } from "viem";

/**
 * Is this a hex address, ignoring EIP-55 casing?
 *
 * viem's `isAddress` verifies the checksum whenever the input is mixed-case,
 * which is exactly right for an address a human typed and exactly wrong for
 * one a wallet handed us: a provider that returns a non-canonically-cased
 * address is unusual but not invalid, and rejecting it would silently drop a
 * wallet somebody had just signed for. Nothing here is typed by hand, so the
 * checksum has no typo to catch — lowercase first, then let `getAddress`
 * produce the canonical form.
 */
const looksLikeAddress = (a: unknown): a is string =>
  typeof a === "string" && isAddress(a.toLowerCase());

export interface BookedWallet {
  address: Address;
  /**
   * How it was proved — an EIP-6963 rdns like `io.metamask`, or `base` for a
   * Base Account. Display only; the signature is what made it real.
   */
  kind: string;
  /** What the wallet called itself when it announced, e.g. "MetaMask". */
  label: string;
  /** ms epoch. */
  linkedAt: number;
}

export interface WalletBook {
  wallets: BookedWallet[];
  /** Lowercased address of the payout wallet, or null if the book is empty. */
  payout: string | null;
}

const BOOK_KEY = "vibe.walletBook.v1";
/** The single-address keys this replaces. Read once, never written again. */
const LEGACY_ADDR = "vibe.payoutAddress.v1";
const LEGACY_KIND = "vibe.payoutKind.v1";

/** Pretty names for the kinds we can name without the wallet telling us. */
const KIND_LABEL: Record<string, string> = {
  base: "Vibe Wallet",
  "io.metamask": "MetaMask",
  "com.coinbase.wallet": "Coinbase Wallet",
  "io.rabby": "Rabby",
  "app.phantom": "Phantom",
  injected: "Browser wallet",
};

export const labelForKind = (kind: string, fallback = "Wallet"): string =>
  KIND_LABEL[kind] ?? fallback;

/** A Base Account is the one kind the vibeverse made; say so in the UI. */
export const isVibeWallet = (w: BookedWallet): boolean => w.kind === "base";

const empty = (): WalletBook => ({ wallets: [], payout: null });

function parse(raw: string): WalletBook | null {
  try {
    const p = JSON.parse(raw) as WalletBook;
    if (!Array.isArray(p.wallets)) return null;
    const wallets = p.wallets
      .filter((w) => w && looksLikeAddress(w.address))
      .map((w) => ({ ...w, address: getAddress(w.address) }));
    const known = new Set(wallets.map((w) => w.address.toLowerCase()));
    return {
      wallets,
      // A payout pointing at a wallet that is no longer in the book would show
      // an empty "sending to" line, which is worse than showing none.
      payout: p.payout && known.has(p.payout) ? p.payout : (wallets[0]?.address.toLowerCase() ?? null),
    };
  } catch {
    return null;
  }
}

/**
 * Bring the old single-address keys forward.
 *
 * Someone who linked before this file existed has a proved address and no
 * memory of which wallet proved it beyond `vibe.payoutKind.v1`. That is enough
 * to put them in the book without asking them to sign again, which is the
 * whole point of migrating rather than starting clean.
 */
function adoptLegacy(): WalletBook {
  if (typeof localStorage === "undefined") return empty();
  try {
    const addr = localStorage.getItem(LEGACY_ADDR);
    if (!looksLikeAddress(addr)) return empty();
    const kind = localStorage.getItem(LEGACY_KIND) ?? "injected";
    const one: BookedWallet = {
      address: getAddress(addr),
      kind,
      label: labelForKind(kind),
      linkedAt: 0, // unknown, and "0" reads as "before we started counting"
    };
    return { wallets: [one], payout: one.address.toLowerCase() };
  } catch {
    return empty();
  }
}

function read(): WalletBook {
  if (typeof localStorage === "undefined") return empty();
  const raw = localStorage.getItem(BOOK_KEY);
  const parsed = raw ? parse(raw) : null;
  return parsed ?? adoptLegacy();
}

let book: WalletBook = read();
const listeners = new Set<(b: WalletBook) => void>();

function commit(next: WalletBook): void {
  book = next;
  try {
    localStorage.setItem(BOOK_KEY, JSON.stringify(next));
    /* Keep the legacy key in step. `VibeCoinChip` and `readPayoutAddress` still
       read it, and a half-migrated app showing two different payout addresses
       in two places is worse than one duplicated write. */
    const payout = next.wallets.find((w) => w.address.toLowerCase() === next.payout);
    if (payout) {
      localStorage.setItem(LEGACY_ADDR, payout.address);
      localStorage.setItem(LEGACY_KIND, payout.kind);
    } else {
      localStorage.removeItem(LEGACY_ADDR);
      localStorage.removeItem(LEGACY_KIND);
    }
  } catch {
    /* Private mode. The session works; it forgets on reload. */
  }
  for (const l of listeners) l(next);
}

export const getWalletBook = (): WalletBook => book;

/**
 * Watch the book. Fires on every change, once.
 *
 * No window event alongside this. There was one, and because the module is a
 * singleton every subscriber received both — so a component that re-fetched
 * balances on change fetched them twice for every link.
 */
export function subscribeWalletBook(fn: (b: WalletBook) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** The wallet a drop would be sent to, or null. */
export function payoutWallet(): BookedWallet | null {
  return book.wallets.find((w) => w.address.toLowerCase() === book.payout) ?? null;
}

export const hasWallets = (): boolean => book.wallets.length > 0;

/**
 * Record a freshly proved address.
 *
 * Re-linking an address already in the book updates how it was proved rather
 * than adding a duplicate — the same account can legitimately be reached
 * through two different wallets, and two rows for one address would just be a
 * confusing way of saying that.
 *
 * A newly added wallet becomes the payout wallet. Somebody who just went
 * through a signature prompt meant to use that one.
 */
export function addWallet(entry: {
  address: string;
  kind: string;
  label?: string;
}): WalletBook {
  if (!looksLikeAddress(entry.address)) return book;
  const address = getAddress(entry.address);
  const key = address.toLowerCase();
  const next: BookedWallet = {
    address,
    kind: entry.kind,
    label: entry.label || labelForKind(entry.kind),
    linkedAt: Date.now(),
  };
  const wallets = [
    next,
    ...book.wallets.filter((w) => w.address.toLowerCase() !== key),
  ];
  commit({ wallets, payout: key });
  return book;
}

/** Point the drop at a different wallet you have already proved. */
export function setPayoutWallet(address: string): WalletBook {
  const key = address.toLowerCase();
  if (!book.wallets.some((w) => w.address.toLowerCase() === key)) return book;
  commit({ ...book, payout: key });
  return book;
}

/**
 * Forget a wallet.
 *
 * Local only — nothing on chain changes and the server keeps whatever it was
 * last told, which is why removing the *payout* wallet promotes another rather
 * than leaving the book pointing at nothing.
 */
export function removeWallet(address: string): WalletBook {
  const key = address.toLowerCase();
  const wallets = book.wallets.filter((w) => w.address.toLowerCase() !== key);
  const payout = book.payout === key ? (wallets[0]?.address.toLowerCase() ?? null) : book.payout;
  commit({ wallets, payout });
  return book;
}
