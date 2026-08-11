/**
 * Sign in with a wallet — the browser half.
 *
 * ## This is a login, and `link-wallet` is not
 *
 * There are now two things you can do with a wallet here and they are easy to
 * confuse. **Linking** (`VibeWalletConnect`, `link-wallet`) answers *where do
 * we send your tokens*; it can happen with or without an account and it leaves
 * you exactly as signed-out as it found you. **Signing in** — this file — ends
 * with a real Supabase session, so `useVibeIdentity`, RLS, Vibecoin, the
 * wardrobe and the passport all see a logged-in person who happens to have
 * arrived through MetaMask.
 *
 * ## Three round trips, and why none of them can be dropped
 *
 *   1. `eth_requestAccounts` — which wallet, which account. The user's choice.
 *   2. `wallet-auth { action: "nonce" }` — the server writes the sentence to
 *      sign. It has to be the server's sentence: a signature over a string we
 *      let the client choose is a bearer token that never expires, and one we
 *      let it *reuse* is not a login at all.
 *   3. `personal_sign` then `wallet-auth { action: "verify" }` — the proof, and
 *      a single-use token traded for a session.
 *
 * It looks like it ought to collapse into one call. It does not: the nonce
 * exists precisely so that step 3 cannot be replayed, which means it cannot be
 * predicted, which means somebody has to hand it out first.
 *
 * ## Keep this file cheap to import
 *
 * `VibeAuthDialog` hangs off the log-in button in the global nav, so anything
 * reachable from here lands in the chunk every page downloads. That is why it
 * talks to EIP-1193 providers directly rather than importing `vibe-wallet.ts`
 * (viem plus a chain definition) or `baseAccount.ts` (half a megabyte of
 * passkey SDK). The Base Account has its own door on `/wallet`.
 */
import { supabase } from "@/integrations/supabase/client";
import { addWallet } from "@/lib/walletBook";
import {
  discoverWallets,
  requestAccount,
  type DiscoveredWallet,
  type Eip1193Provider,
} from "@/lib/wallets";

/** EIP-6963 `rdns` for MetaMask proper. Stable, and the wallet's own claim. */
export const METAMASK_RDNS = "io.metamask";

/** How long to let wallets announce themselves before deciding none did. */
const DISCOVERY_MS = 400;

export interface WalletSignInResult {
  address: string;
  /** True the first time this wallet has ever signed in here. */
  isNewAccount: boolean;
  /** What the wallet calls itself, for the toast. */
  walletName: string;
}

/**
 * Wait for the installed wallets to announce themselves.
 *
 * `discoverWallets` is a subscription because a wallet can inject late; this
 * wraps it in the promise callers actually want. The timeout is not a guess at
 * network latency — announcement is synchronous and local — it is a grace
 * period for extensions that register their listener a tick after page load.
 */
export function findWallets(timeoutMs = DISCOVERY_MS): Promise<DiscoveredWallet[]> {
  return new Promise((resolve) => {
    let latest: DiscoveredWallet[] = [];
    const stop = discoverWallets((ws) => {
      latest = ws;
    });
    window.setTimeout(() => {
      stop();
      resolve(latest);
    }, timeoutMs);
  });
}

/**
 * Pick the wallet a button labelled "MetaMask" should actually open.
 *
 * Three tiers, because the honest answer degrades:
 *  - the wallet that announced itself as `io.metamask`, which is MetaMask;
 *  - one whose announced name says MetaMask, for forks and betas that pick
 *    their own rdns;
 *  - the generic `injected` fallback, but only when it admits to `isMetaMask`.
 *    Half the wallet extensions ever written set that flag to get past sniffing
 *    code, so it is worth exactly as much as a last resort and no more.
 *
 * Returns null rather than guessing. A button that says MetaMask and opens
 * Phantom is worse than a button that says "no MetaMask here".
 */
export function pickMetaMask(wallets: DiscoveredWallet[]): DiscoveredWallet | null {
  const byRdns = wallets.find((w) => w.id === METAMASK_RDNS);
  if (byRdns) return byRdns;

  const byName = wallets.find((w) => /metamask/i.test(w.name));
  if (byName) return byName;

  const injected = wallets.find(
    (w) => w.id === "injected" && (w.provider as { isMetaMask?: boolean }).isMetaMask,
  );
  return injected ?? null;
}

/**
 * The MetaMask app's deep link for "open this page in my browser".
 *
 * On a phone, a page in Safari has no wallet to discover and never will —
 * MetaMask on mobile is a browser, not an extension. Sending somebody to
 * metamask.io to "install" it is the wrong instruction and a dead end; this
 * reopens the exact page they are on inside the app, where the wallet exists.
 *
 * Deliberately scheme-less: the link format is `metamask.app.link/dapp/<host
 * and path, no protocol>`, and including `https://` yields a URL MetaMask
 * opens as a broken relative path.
 */
export function metamaskDeepLink(url = window.location.href): string {
  return `https://metamask.app.link/dapp/${url.replace(/^https?:\/\//, "")}`;
}

/** Did the person simply close the wallet prompt? Not an error worth shouting. */
export function isUserRejection(err: unknown): boolean {
  const code = (err as { code?: number })?.code;
  if (code === 4001 || code === 4100) return true;
  const msg = String((err as Error)?.message ?? err ?? "");
  return /user (rejected|denied|cancell?ed)|request rejected|denied message signature|4001/i.test(
    msg,
  );
}

/** One call into the edge function, with its two error shapes flattened. */
async function callWalletAuth<T>(action: string, payload: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke("wallet-auth", {
    body: { ...payload, action },
  });
  /* `invoke` reports a non-2xx as a transport error whose message is a generic
     "non-2xx status code", and the reason we actually want is in the body it
     already parsed. Prefer the body's message whenever there is one. */
  if (data?.error) throw new Error(String(data.error));
  if (error) throw new Error(error.message);
  return data as T;
}

/**
 * Take a wallet from "installed" to "signed in", prompts and all.
 *
 * Throws on failure — including on user rejection, which callers should test
 * for with `isUserRejection` and swallow. Closing a wallet prompt is a
 * decision, and answering a decision with a red toast reads as a bug.
 */
export async function signInWithWallet(
  wallet: DiscoveredWallet,
): Promise<WalletSignInResult> {
  const address = await requestAccount(wallet.provider);

  const { nonce, message } = await callWalletAuth<{ nonce: string; message: string }>(
    "nonce",
    { address },
  );

  const signature = (await wallet.provider.request({
    method: "personal_sign",
    /* [message, address], in that order. `eth_sign` takes them the other way
       round and wallets do not correct you — they sign your address as the
       message and hand back a signature that verifies against nothing. */
    params: [message, address],
  })) as string;

  const { token_hash, isNewAccount } = await callWalletAuth<{
    token_hash: string;
    isNewAccount: boolean;
  }>("verify", { nonce, signature });

  /* The trade: a single-use token for a session. `type: "magiclink"` has to
     match the type the server generated; "email" is the OTP-code flow and is
     rejected here even though both arrive as a token_hash. */
  const { error } = await supabase.auth.verifyOtp({
    token_hash,
    type: "magiclink",
  });
  if (error) throw new Error(error.message);

  /* Put it in the wallet book too, so `/wallet` shows the address they just
     proved instead of asking them to prove it again for the payout. */
  addWallet({ address, kind: wallet.id, label: wallet.name });

  return { address, isNewAccount, walletName: wallet.name };
}

/** Re-exported so callers need one import, not three. */
export type { DiscoveredWallet, Eip1193Provider };
