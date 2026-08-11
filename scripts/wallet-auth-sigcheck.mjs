/**
 * Does the exact message the edge function builds survive a real
 * personal_sign round trip, and does the verification path it uses accept it?
 *
 * This is the half of wallet-auth that no unit test in the app can reach: the
 * function runs on Deno, in Supabase's network, and the interesting failure
 * (verifying against bytes that differ by one character) is invisible until a
 * real wallet signs.
 */
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { createPublicClient, http, verifyMessage, getAddress } from "viem";
import { base } from "viem/chains";

// A verbatim copy of buildSignInMessage from supabase/functions/wallet-auth.
function buildSignInMessage({ address, origin, nonce, issuedAt }) {
  return [
    `${origin} wants you to sign in with your Ethereum account:`,
    address,
    "",
    "Welcome to the Vibeverse. Signing this proves you hold this wallet and",
    "signs you in. It is a signature, not a transaction — nothing moves out of",
    "your wallet and there is no fee.",
    "",
    "Chain: Base (8453)",
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt.toISOString()}`,
  ].join("\n");
}

const account = privateKeyToAccount(generatePrivateKey());
const address = getAddress(account.address);
const message = buildSignInMessage({
  address,
  origin: "vibeverse.com",
  nonce: "0123456789abcdef",
  issuedAt: new Date("2026-08-11T12:00:00.000Z"),
});

console.log("--- message the wallet would show ---");
console.log(message);
console.log("-------------------------------------");

// personal_sign is exactly what signMessage produces.
const signature = await account.signMessage({ message });

// 1. The offline path (EOA recovery), which is what MetaMask hits.
const offline = await verifyMessage({ address, message, signature });
console.log("ecrecover verify (EOA / MetaMask):", offline);

// 2. The path the function actually calls, which additionally covers
//    ERC-1271 / ERC-6492 smart accounts.
const publicClient = createPublicClient({ chain: base, transport: http() });
let viaClient = null;
try {
  viaClient = await publicClient.verifyMessage({ address, message, signature });
} catch (e) {
  viaClient = `threw: ${String(e).slice(0, 120)}`;
}
console.log("publicClient.verifyMessage:", viaClient);

// 3. A tampered message must fail — this is the whole security property.
const tampered = await verifyMessage({
  address,
  message: message.replace("Nonce: 0123456789abcdef", "Nonce: deadbeefdeadbeef"),
  signature,
});
console.log("tampered nonce verifies (must be false):", tampered);

// 4. A different address must fail.
const other = privateKeyToAccount(generatePrivateKey());
const wrongAddr = await verifyMessage({ address: other.address, message, signature });
console.log("wrong address verifies (must be false):", wrongAddr);
