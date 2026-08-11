/**
 * Signing in with a wallet, tested where it can actually be wrong.
 *
 * The interesting failures here are all silent ones. A wallet flow that signs
 * the wrong string still pops a prompt and still looks like it worked, right
 * up until the server rejects it; a button labelled MetaMask that opens
 * Phantom is indistinguishable from a working button until somebody notices
 * the address changed. So the assertions are about *which bytes went where*
 * rather than about the happy path returning truthy.
 *
 * Four things that must stay true:
 *
 *   1. the string handed to the wallet is the server's, character for
 *      character — the nonce is worthless if the client can pick the message;
 *   2. `personal_sign` gets [message, address] in that order, because the
 *      other order is `eth_sign`'s and wallets sign it without complaint;
 *   3. the token is redeemed as a `magiclink`, matching what the server minted;
 *   4. "MetaMask" means MetaMask, or it says so.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
const verifyOtp = vi.hoisted(() => vi.fn());

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { functions: { invoke }, auth: { verifyOtp } },
}));

import {
  isUserRejection,
  metamaskDeepLink,
  pickMetaMask,
  signInWithWallet,
  type DiscoveredWallet,
} from "@/lib/walletAuth";

const ADDRESS = "0x7255ecf1020a95fed5323dd4feb23a54ab1aa7d1";
const SERVER_MESSAGE =
  "vibeverse.com wants you to sign in with your Ethereum account:\n" +
  `${ADDRESS}\n\nChain: Base (8453)\nNonce: abc123\nIssued At: 2026-08-11T00:00:00.000Z`;

/** A wallet that says yes to everything and records what it was asked. */
function fakeWallet(overrides: Partial<DiscoveredWallet> = {}): DiscoveredWallet {
  return {
    id: "io.metamask",
    name: "MetaMask",
    icon: "",
    provider: {
      request: vi.fn(async ({ method }: { method: string }) => {
        if (method === "eth_requestAccounts") return [ADDRESS];
        if (method === "personal_sign") return "0xsignature";
        throw new Error(`unexpected method ${method}`);
      }),
    },
    ...overrides,
  } as DiscoveredWallet;
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  invoke.mockImplementation(async (_fn: string, opts: { body: Record<string, unknown> }) => {
    if (opts.body.action === "nonce") {
      return { data: { nonce: "abc123", message: SERVER_MESSAGE }, error: null };
    }
    return { data: { token_hash: "hashed-token", isNewAccount: true }, error: null };
  });
  verifyOtp.mockResolvedValue({ data: {}, error: null });
});

describe("signInWithWallet", () => {
  it("signs the exact message the server issued, not one it built itself", async () => {
    const wallet = fakeWallet();
    await signInWithWallet(wallet);

    const req = wallet.provider.request as ReturnType<typeof vi.fn>;
    const signCall = req.mock.calls.find(
      ([args]) => (args as { method: string }).method === "personal_sign",
    );
    expect(signCall).toBeDefined();
    // Character for character. A client that trims, re-wraps or re-orders this
    // is verifying against bytes the nonce row does not contain.
    expect((signCall![0] as { params: unknown[] }).params[0]).toBe(SERVER_MESSAGE);
  });

  it("passes personal_sign its arguments as [message, address]", async () => {
    const wallet = fakeWallet();
    await signInWithWallet(wallet);

    const req = wallet.provider.request as ReturnType<typeof vi.fn>;
    const params = req.mock.calls.find(
      ([args]) => (args as { method: string }).method === "personal_sign",
    )![0] as { params: unknown[] };
    expect(params.params).toEqual([SERVER_MESSAGE, ADDRESS]);
  });

  it("redeems the token as a magiclink, matching what the server minted", async () => {
    await signInWithWallet(fakeWallet());
    expect(verifyOtp).toHaveBeenCalledWith({
      token_hash: "hashed-token",
      type: "magiclink",
    });
  });

  it("sends the nonce back with the signature, never the message", async () => {
    await signInWithWallet(fakeWallet());
    const verifyBody = invoke.mock.calls.find(
      ([, opts]) => (opts as { body: { action: string } }).body.action === "verify",
    )![1] as { body: Record<string, unknown> };
    expect(verifyBody.body).toMatchObject({ nonce: "abc123", signature: "0xsignature" });
    expect(verifyBody.body.message).toBeUndefined();
  });

  it("surfaces the edge function's own error text, not the transport's", async () => {
    invoke.mockResolvedValue({
      data: { error: "that sign-in request was already used" },
      // What `functions.invoke` reports for any non-2xx: technically true,
      // useless to a human, and the reason we prefer the body.
      error: { message: "Edge Function returned a non-2xx status code" },
    });
    await expect(signInWithWallet(fakeWallet())).rejects.toThrow(
      "that sign-in request was already used",
    );
  });

  it("does not open a session when the token is refused", async () => {
    verifyOtp.mockResolvedValue({ data: null, error: { message: "Token has expired" } });
    await expect(signInWithWallet(fakeWallet())).rejects.toThrow("Token has expired");
  });

  it("records the address in the wallet book so /wallet does not re-ask", async () => {
    await signInWithWallet(fakeWallet());
    const { getWalletBook } = await import("@/lib/walletBook");
    expect(getWalletBook().wallets.map((w) => w.address.toLowerCase())).toContain(ADDRESS);
  });
});

describe("pickMetaMask", () => {
  const w = (id: string, name: string, provider = {}): DiscoveredWallet =>
    ({ id, name, icon: "", provider } as unknown as DiscoveredWallet);

  it("prefers the wallet that announced io.metamask", () => {
    const wallets = [w("io.rabby", "Rabby"), w("io.metamask", "MetaMask")];
    expect(pickMetaMask(wallets)?.id).toBe("io.metamask");
  });

  it("falls back to a wallet whose name says MetaMask", () => {
    expect(pickMetaMask([w("io.metamask.flask", "MetaMask Flask")])?.name).toBe(
      "MetaMask Flask",
    );
  });

  it("accepts a bare injected provider only when it claims isMetaMask", () => {
    expect(pickMetaMask([w("injected", "Browser wallet", { isMetaMask: true })])).not.toBeNull();
    expect(pickMetaMask([w("injected", "Browser wallet", {})])).toBeNull();
  });

  it("returns null rather than offering an unrelated wallet", () => {
    // A button that says MetaMask and opens Phantom is worse than one that
    // admits there is no MetaMask here.
    expect(pickMetaMask([w("app.phantom", "Phantom"), w("io.rabby", "Rabby")])).toBeNull();
  });

  it("has nothing to offer an empty browser", () => {
    expect(pickMetaMask([])).toBeNull();
  });
});

describe("metamaskDeepLink", () => {
  it("drops the scheme, which MetaMask would otherwise read as a relative path", () => {
    expect(metamaskDeepLink("https://vibeverse.com/lobby")).toBe(
      "https://metamask.app.link/dapp/vibeverse.com/lobby",
    );
  });

  it("keeps the query string, so a deep link into a world survives the trip", () => {
    expect(metamaskDeepLink("https://vibeverse.com/play/x?level=3")).toBe(
      "https://metamask.app.link/dapp/vibeverse.com/play/x?level=3",
    );
  });
});

describe("isUserRejection", () => {
  it("recognises the EIP-1193 rejection code", () => {
    expect(isUserRejection({ code: 4001 })).toBe(true);
  });

  it("recognises the phrasings wallets actually use", () => {
    for (const msg of [
      "User rejected the request.",
      "MetaMask Message Signature: User denied message signature.",
      "User cancelled the request",
    ]) {
      expect(isUserRejection(new Error(msg))).toBe(true);
    }
  });

  it("does not swallow a real failure", () => {
    // These must reach a toast. Treating them as "they changed their mind"
    // is how a broken deploy looks like normal behaviour.
    expect(isUserRejection(new Error("that signature did not verify"))).toBe(false);
    expect(isUserRejection(new Error("Failed to fetch"))).toBe(false);
  });
});
