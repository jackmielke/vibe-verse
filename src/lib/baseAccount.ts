/**
 * The Vibe Wallet — a Base Account, created with a passkey.
 *
 * ## Why this and not a key we generate
 *
 * The first version of "make me a wallet" called `generatePrivateKey()` and put
 * the result in `localStorage`. It worked, it was honest about itself, and it
 * had exactly one fatal property: **no recovery**. Clear your browser and the
 * money is gone, with nobody to ask. That is an acceptable trade for an address
 * to post an airdrop to and an unacceptable one for a wallet somebody keeps
 * anything in.
 *
 * A Base Account is different in every way that matters here:
 *
 * - **A passkey, not a seed phrase.** Face ID or a fingerprint. Nothing to
 *   write down, nothing to lose in a text file.
 * - **Recovery that already exists.** Passkeys sync through iCloud Keychain or
 *   the Google password manager, so a new phone still has the wallet.
 * - **It is theirs, not ours.** One Base Account works across every Base app.
 *   A wallet that only functions inside the game that issued it is a points
 *   balance wearing a costume.
 * - **A real smart contract account**, which is what makes sponsored gas
 *   possible — see `PAYMASTER_URL` below.
 *
 * We never see the key. The passkey lives with the platform authenticator and
 * signs in a popup we do not control, which is the point.
 *
 * ## What this file does NOT do
 *
 * Send transactions. The Vibeverse still never moves a token. This exists to
 * *prove an address* so a distribution has somewhere to go, exactly as the
 * browser-wallet path does — the signature is the only thing we ask for.
 */
import { createBaseAccountSDK } from "@base-org/account";
import { base } from "viem/chains";
import { getAddress, type Address } from "viem";

/**
 * Sponsored gas, when it is switched on.
 *
 * A brand-new wallet holds zero ETH. It can *receive* $VIBE all day — the
 * sender pays — but the first time its owner wants to move anything they need
 * gas they do not have and would not know how to buy. That is where a
 * first-time user actually gives up, and it is invisible until somebody tries.
 *
 * A paymaster fixes it: the app pays, and the wallet just works. Set
 * `VITE_BASE_PAYMASTER_URL` to a Coinbase Developer Platform paymaster endpoint
 * to turn it on. Left unset, everything here still works — nothing in the
 * vibeverse needs a transaction today — so this is a slot, not a dependency.
 */
const PAYMASTER_URL = import.meta.env.VITE_BASE_PAYMASTER_URL as string | undefined;

let sdk: ReturnType<typeof createBaseAccountSDK> | null = null;

/**
 * One SDK instance for the tab.
 *
 * Built lazily: it wires up window listeners and a popup channel, and a visitor
 * who never opens the wallet card should not pay for either.
 */
function getSdk() {
  if (sdk) return sdk;
  sdk = createBaseAccountSDK({
    appName: "The Vibeverse",
    appLogoUrl: `${window.location.origin}/favicon.ico`,
    appChainIds: [base.id],
    ...(PAYMASTER_URL ? { paymasterUrls: { [base.id]: PAYMASTER_URL } } : {}),
  });
  return sdk;
}

export function isPaymasterConfigured(): boolean {
  return !!PAYMASTER_URL;
}

/**
 * Create or open the visitor's Base Account and return its address.
 *
 * One prompt: a passkey the platform authenticator owns. If they already have
 * a Base Account — from this app or any other — this signs them into it rather
 * than making a second one, which is the whole argument for using theirs.
 */
export async function connectBaseAccount(): Promise<Address> {
  const provider = getSdk().getProvider();
  const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
  if (!accounts?.length) throw new Error("no account came back from Base");
  return getAddress(accounts[0]);
}

/**
 * Sign the link proof with the Base Account.
 *
 * The signature that comes back is **not** an ECDSA signature over the message.
 * A Base Account is a contract, so it produces an ERC-1271 signature — or, if
 * the account has never transacted and therefore is not deployed yet, an
 * ERC-6492-wrapped one. `ecrecover` rejects both. The `link-wallet` function
 * verifies through a Base RPC for exactly this reason; see the long comment
 * there before changing either side.
 */
export async function signWithBaseAccount(address: Address, message: string): Promise<string> {
  const provider = getSdk().getProvider();
  const signature = (await provider.request({
    method: "personal_sign",
    params: [message, address],
  })) as string;
  if (!signature) throw new Error("Base returned an empty signature");
  return signature;
}

/** Forget the connection in this tab. The passkey and the account persist. */
export async function disconnectBaseAccount(): Promise<void> {
  try {
    await sdk?.getProvider().disconnect();
  } catch {
    /* Already gone. */
  }
  sdk = null;
}

/**
 * Passkeys need a secure context and a platform authenticator.
 *
 * Returns false on plain http (other than localhost) and in browsers with no
 * WebAuthn at all — where the button would open a popup that could only fail.
 * Better to not offer it than to offer it and break.
 */
export function canUsePasskeys(): boolean {
  if (typeof window === "undefined") return false;
  return window.isSecureContext === true && !!window.PublicKeyCredential;
}
