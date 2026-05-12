/**
 * vibe-wallet — browser wallet integration for $VIBE on Base.
 *
 * Three layers, top-to-bottom:
 *
 *   1. `connectWallet()` — pop the browser wallet (MetaMask, Coinbase
 *      Wallet, Rabby, Phantom, etc), ask the user to pick an account,
 *      switch to Base if needed, return the address.
 *
 *   2. `signLinkMessage(address)` — produce a SIWE-style proof-of-
 *      ownership signature. We bundle {address, message, signature}
 *      so an edge function can verify the user actually controls
 *      the wallet before we trust it server-side.
 *
 *   3. `getVibeBalance(address)` — pure on-chain read via viem's
 *      public client. No auth, no key, just an RPC call to Base.
 *
 * The session (address + signature) is persisted to localStorage so
 * the user doesn't have to reconnect on every reload. We DO NOT store
 * any private key material — wallets handle that themselves.
 *
 * Designed to be portable: nothing in this file imports app-specific
 * modules, so you can copy it into another Vite + viem project and
 * it works.
 */

import {
  createPublicClient,
  http,
  formatUnits,
  type Address,
  type Hash,
  getAddress,
  isAddress,
  hexToString,
} from "viem";
import { base } from "viem/chains";

// $VIBE token on Base (the canonical contract).
export const VIBE_TOKEN_ADDRESS: Address =
  "0x7255ecf1020a95fed5323dd4feb23a54ab1aa7d1";
export const VIBE_TOKEN_DECIMALS = 18;
export const VIBE_TOKEN_SYMBOL = "VIBE";

// Base mainnet — chainId 8453. Hex form for `wallet_switchEthereumChain`.
export const BASE_CHAIN_ID = 8453;
export const BASE_CHAIN_ID_HEX = "0x2105";

// Minimal ERC-20 ABI — we only need balanceOf + decimals + symbol.
const ERC20_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    type: "function",
    name: "symbol",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

// Public Base RPC. The default is fine for read-only balance queries;
// users can override via VITE_BASE_RPC_URL if they're rate-limited.
const BASE_RPC_URL =
  (import.meta as unknown as { env?: { VITE_BASE_RPC_URL?: string } }).env
    ?.VITE_BASE_RPC_URL ?? "https://mainnet.base.org";

export const basePublicClient = createPublicClient({
  chain: base,
  transport: http(BASE_RPC_URL),
});

// ----------------------------------------------------------------------
// Browser-wallet detection
// ----------------------------------------------------------------------

// Standard EIP-1193 provider interface. We DO NOT use viem's
// `createWalletClient` here because the user might switch accounts /
// chains in their wallet UI after we've cached a client; talking to
// window.ethereum directly keeps us in sync with reality.
interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] | Record<string, unknown> }): Promise<unknown>;
  on?(event: string, handler: (...args: unknown[]) => void): void;
  removeListener?(event: string, handler: (...args: unknown[]) => void): void;
}

function getProvider(): Eip1193Provider | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { ethereum?: Eip1193Provider };
  return w.ethereum ?? null;
}

export function hasWallet(): boolean {
  return getProvider() != null;
}

// ----------------------------------------------------------------------
// Connect / disconnect
// ----------------------------------------------------------------------

export interface LinkedWallet {
  address: Address;
  message: string;
  signature: Hash;
  signedAt: number; // ms epoch
}

const STORAGE_KEY = "vibe.wallet.session.v1";

export function loadSession(): LinkedWallet | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as LinkedWallet;
    if (!isAddress(parsed.address)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveSession(s: LinkedWallet): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
}

export function clearSession(): void {
  localStorage.removeItem(STORAGE_KEY);
}

/**
 * Connect to the user's browser wallet, switch to Base if needed,
 * return their selected address. Throws if the user cancels.
 */
export async function connectWallet(): Promise<Address> {
  const provider = getProvider();
  if (!provider) {
    throw new Error(
      "No browser wallet detected. Install MetaMask, Coinbase Wallet, " +
      "Rabby, or another EIP-1193 wallet to connect.",
    );
  }

  const accounts = (await provider.request({
    method: "eth_requestAccounts",
  })) as string[];
  if (!accounts?.length) {
    throw new Error("Wallet returned no accounts");
  }
  const address = getAddress(accounts[0]);

  // Ensure we're on Base. If the wallet doesn't know about Base yet,
  // try to add it first.
  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: BASE_CHAIN_ID_HEX }],
    });
  } catch (err) {
    // 4902 = chain not added.
    const code = (err as { code?: number }).code;
    if (code === 4902) {
      await provider.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: BASE_CHAIN_ID_HEX,
            chainName: "Base",
            nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
            rpcUrls: [BASE_RPC_URL],
            blockExplorerUrls: ["https://basescan.org"],
          },
        ],
      });
    } else {
      // 4001 = user rejected. Anything else, fall through — the user
      // might already be on Base (and the switch errored because
      // there's nothing to do).
    }
  }

  return address;
}

// ----------------------------------------------------------------------
// Sign the link message
// ----------------------------------------------------------------------

/**
 * Build the human-readable message the user signs to link their
 * wallet to a community. Following SIWE structure loosely: the user
 * sees who's asking, what domain, and an issued-at timestamp so old
 * signatures can't be replayed forever.
 */
export function buildLinkMessage(opts: {
  address: Address;
  community: string; // e.g. "Edge Esmeralda"
  domain?: string;
  nonce?: string;
  issuedAt?: string;
}): string {
  const domain = opts.domain ?? (typeof window !== "undefined" ? window.location.host : "edgeesmeralda.app");
  const nonce = opts.nonce ?? Math.random().toString(36).slice(2, 12);
  const issuedAt = opts.issuedAt ?? new Date().toISOString();
  return (
    `${domain} wants you to link your wallet:\n` +
    `${opts.address}\n\n` +
    `By signing, you're attaching this wallet to your ${opts.community} profile so members can see your $VIBE balance.\n` +
    `No transactions are sent. No funds move. You can disconnect anytime.\n\n` +
    `Chain: Base (8453)\n` +
    `Nonce: ${nonce}\n` +
    `Issued At: ${issuedAt}`
  );
}

/**
 * Ask the wallet to sign the link message. Returns the bundle the
 * server (or any verifier) needs to confirm authenticity.
 */
export async function signLinkMessage(
  address: Address,
  community: string,
): Promise<LinkedWallet> {
  const provider = getProvider();
  if (!provider) throw new Error("No wallet provider");
  const message = buildLinkMessage({ address, community });
  // `personal_sign` is the de-facto standard for human-readable
  // string sigs; works in every mainstream wallet.
  const signature = (await provider.request({
    method: "personal_sign",
    params: [message, address],
  })) as Hash;
  const session: LinkedWallet = {
    address,
    message,
    signature,
    signedAt: Date.now(),
  };
  saveSession(session);
  return session;
}

// ----------------------------------------------------------------------
// Reads — balances + symbol
// ----------------------------------------------------------------------

export interface VibeBalance {
  raw: bigint;
  formatted: string; // human-readable with full precision
  usd?: number;
}

/** Get a single address's $VIBE balance, formatted. */
export async function getVibeBalance(address: Address): Promise<VibeBalance> {
  const raw = (await (basePublicClient.readContract as (args: unknown) => Promise<unknown>)({
    address: VIBE_TOKEN_ADDRESS,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [address],
  })) as bigint;
  return {
    raw,
    formatted: formatUnits(raw, VIBE_TOKEN_DECIMALS),
  };
}

/**
 * Batch-read balances for a list of addresses. Sequential reads are
 * fine for small lists; for very large lists you'd want multicall3,
 * but multicall adds an ABI + contract address dance we don't need
 * at our community scale (~dozens, not thousands).
 */
export async function getVibeBalances(
  addresses: Address[],
): Promise<Record<string, bigint>> {
  const results = await Promise.all(
    addresses.map(async (addr) => {
      try {
        const b = await getVibeBalance(addr);
        return [addr.toLowerCase(), b.raw] as const;
      } catch {
        return [addr.toLowerCase(), 0n] as const;
      }
    }),
  );
  return Object.fromEntries(results);
}

/** Pretty-print a wei amount as a human-friendly token figure. */
export function formatVibe(amount: bigint | number, opts: { compact?: boolean } = {}): string {
  const big = typeof amount === "bigint" ? amount : BigInt(Math.trunc(amount));
  const asFloat = Number(formatUnits(big, VIBE_TOKEN_DECIMALS));
  if (opts.compact && Math.abs(asFloat) >= 1000) {
    if (Math.abs(asFloat) >= 1e9) return `${(asFloat / 1e9).toFixed(2)}B`;
    if (Math.abs(asFloat) >= 1e6) return `${(asFloat / 1e6).toFixed(2)}M`;
    if (Math.abs(asFloat) >= 1e3) return `${(asFloat / 1e3).toFixed(1)}K`;
  }
  if (asFloat === 0) return "0";
  if (asFloat < 0.0001) return asFloat.toExponential(2);
  return asFloat.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });
}

/** Truncate a hex address for display, e.g. 0x7255…a7d1. */
export function shortAddress(addr: string): string {
  if (!addr || addr.length < 10) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

// ----------------------------------------------------------------------
// Transactions
// ----------------------------------------------------------------------

/**
 * Open the user's wallet to send a $VIBE transfer. We build the
 * ERC-20 `transfer` calldata client-side and hand it to the wallet
 * via `eth_sendTransaction` — the wallet handles signing, gas, etc.
 * Returns the tx hash once the user confirms.
 */
export async function sendVibe(opts: {
  from: Address;
  to: Address;
  amount: bigint;
}): Promise<Hash> {
  const provider = getProvider();
  if (!provider) throw new Error("No wallet provider");

  // ERC-20 transfer(to, amount) calldata. Building it manually keeps
  // us off viem's walletClient which would require an account adapter
  // pinned to a specific provider — this way any EIP-1193 wallet
  // works.
  const selector = "0xa9059cbb"; // transfer(address,uint256)
  const toPad = opts.to.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  const amtPad = opts.amount.toString(16).padStart(64, "0");
  const data = `${selector}${toPad}${amtPad}` as Hash;

  const hash = (await provider.request({
    method: "eth_sendTransaction",
    params: [
      {
        from: opts.from,
        to: VIBE_TOKEN_ADDRESS,
        data,
      },
    ],
  })) as Hash;
  return hash;
}

// ----------------------------------------------------------------------
// Event subscription helpers
// ----------------------------------------------------------------------

/**
 * Listen for account / chain changes so the UI can react. Returns
 * an unsubscribe function.
 */
export function onWalletEvents(handlers: {
  accountsChanged?: (accounts: string[]) => void;
  chainChanged?: (chainIdHex: string) => void;
  disconnect?: () => void;
}): () => void {
  const provider = getProvider();
  if (!provider || !provider.on || !provider.removeListener) return () => { /* */ };
  const a = (accounts: unknown) => handlers.accountsChanged?.(accounts as string[]);
  const c = (chainId: unknown) => handlers.chainChanged?.(chainId as string);
  const d = () => handlers.disconnect?.();
  provider.on("accountsChanged", a as (...args: unknown[]) => void);
  provider.on("chainChanged", c as (...args: unknown[]) => void);
  provider.on("disconnect", d as (...args: unknown[]) => void);
  return () => {
    provider.removeListener?.("accountsChanged", a as (...args: unknown[]) => void);
    provider.removeListener?.("chainChanged", c as (...args: unknown[]) => void);
    provider.removeListener?.("disconnect", d as (...args: unknown[]) => void);
  };
}

// Re-export viem helpers callers commonly need so they don't need a
// separate viem import. Keeps consumer code one import shorter.
export { isAddress, getAddress, hexToString };
export type { Address, Hash };
