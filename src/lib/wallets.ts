/**
 * Which wallets can this browser actually offer?
 *
 * ## Why not just `window.ethereum`
 *
 * For years every extension wrote itself to `window.ethereum`, so a browser
 * with MetaMask *and* Rabby installed gave you whichever one loaded last — and
 * no way to reach the other. The user picks a wallet in our UI, taps it, and a
 * different wallet opens. That is not a rare edge case; it is the normal state
 * of a crypto user's browser.
 *
 * **EIP-6963** fixed it. Wallets announce themselves over a window event with a
 * name, an icon and a UUID, and the page collects them. That is what this file
 * does. `window.ethereum` is kept only as a last-resort fallback for a wallet
 * old enough not to announce.
 *
 * The Base Account lives in `baseAccount.ts`, not here — it is not an installed
 * extension, it is a passkey, and it should be offered whether or not the
 * visitor has ever heard of a wallet.
 */
import type { Address } from "viem";

export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] | Record<string, unknown> }): Promise<unknown>;
  on?(event: string, handler: (...args: unknown[]) => void): void;
  removeListener?(event: string, handler: (...args: unknown[]) => void): void;
}

/** One wallet, as announced by the extension itself. */
export interface DiscoveredWallet {
  /** EIP-6963 `rdns`, e.g. `io.metamask`. Stable; use it as the key. */
  id: string;
  name: string;
  /** A data: URI the wallet supplies. Safe to put straight in an <img>. */
  icon: string;
  provider: Eip1193Provider;
}

interface Eip6963Detail {
  info: { uuid: string; name: string; icon: string; rdns: string };
  provider: Eip1193Provider;
}

/**
 * Ask every installed wallet to announce itself, and collect the replies.
 *
 * Synchronous by nature — wallets respond to the request event immediately —
 * but a wallet that injects late would miss a one-shot listen, so callers get a
 * subscription rather than a promise. `subscribe` fires again whenever a new
 * wallet appears.
 */
export function discoverWallets(
  onChange: (wallets: DiscoveredWallet[]) => void,
): () => void {
  if (typeof window === "undefined") return () => {};

  const found = new Map<string, DiscoveredWallet>();

  const emit = () => onChange([...found.values()]);

  const onAnnounce = (event: Event) => {
    const detail = (event as CustomEvent<Eip6963Detail>).detail;
    if (!detail?.info?.rdns || !detail.provider) return;
    if (found.has(detail.info.rdns)) return;
    found.set(detail.info.rdns, {
      id: detail.info.rdns,
      name: detail.info.name,
      icon: detail.info.icon,
      provider: detail.provider,
    });
    emit();
  };

  window.addEventListener("eip6963:announceProvider", onAnnounce);
  window.dispatchEvent(new Event("eip6963:requestProvider"));

  /* The fallback. A wallet that never announces still deserves to be reachable,
     but it has no name or icon to give us, so it is listed generically and
     only when nothing announced — otherwise it shows up as a duplicate of a
     wallet already in the list under its real name. */
  window.setTimeout(() => {
    if (found.size > 0) return;
    const injected = (window as unknown as { ethereum?: Eip1193Provider }).ethereum;
    if (!injected) return;
    found.set("injected", {
      id: "injected",
      name: "Browser wallet",
      icon: "",
      provider: injected,
    });
    emit();
  }, 320);

  emit();
  return () => window.removeEventListener("eip6963:announceProvider", onAnnounce);
}

/** Prompt a specific wallet for an account. Throws if the user declines. */
export async function requestAccount(provider: Eip1193Provider): Promise<Address> {
  const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
  if (!accounts?.length) throw new Error("that wallet returned no accounts");
  return accounts[0] as Address;
}

/**
 * The account this wallet has *already* authorised for this site, if any.
 *
 * `eth_accounts` never prompts — it answers from what the user granted on some
 * previous visit, and returns an empty list otherwise. That distinction is the
 * whole value of it: somebody who connected MetaMask here months ago should be
 * greeted with "link 0x1234…, the one you already use", not with a generic
 * invitation to go and make a wallet they already have three of.
 *
 * Resolves to null on any error. A wallet that dislikes being asked quietly is
 * not a problem worth showing anybody.
 */
export async function authorizedAccount(
  provider: Eip1193Provider,
): Promise<Address | null> {
  try {
    const accounts = (await provider.request({ method: "eth_accounts" })) as string[];
    return accounts?.length ? (accounts[0] as Address) : null;
  } catch {
    return null;
  }
}
