/**
 * Two things here, and the first one is the reason this file exists.
 *
 * ## The ecrecover trap
 *
 * A Base Account is an ERC-4337 smart contract, so what it produces is an
 * ERC-1271 signature — or, before it has ever transacted, an ERC-6492-wrapped
 * one. Neither is an ECDSA signature over the message, and `ecrecover` rejects
 * both.
 *
 * viem exports two things called `verifyMessage`. The one from the package root
 * is a one-line utility that recovers an address and compares it: EOA only. The
 * one from `viem/actions` takes a client and can call the chain. They have the
 * same name, and swapping the second for the first looks like a tidy-up — it
 * removes an import and an RPC round trip — while turning away every passkey
 * wallet with "signature did not verify". That is a bug nobody would find by
 * reading, because the code would look *simpler*.
 *
 * So: assert the deployed function still verifies against a chain.
 *
 * ## Wallet discovery
 *
 * The rest checks EIP-6963 collection, because "the user tapped Rabby and
 * MetaMask opened" is the failure mode `window.ethereum` produces, and it only
 * shows up on a machine with two wallets installed — which is not the machine
 * this gets developed on.
 */
import { describe, expect, it, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { discoverWallets, requestAccount } from "@/lib/wallets";

const LINK_WALLET = readFileSync(
  resolve(process.cwd(), "supabase/functions/link-wallet/index.ts"),
  "utf8",
);

describe("link-wallet verifies smart-account signatures", () => {
  it("verifies against the chain, not with bare ecrecover", () => {
    // The client action. Losing this is what breaks passkey wallets.
    expect(
      LINK_WALLET,
      "link-wallet must verify via a public client so ERC-1271/6492 signatures resolve",
    ).toContain("publicClient.verifyMessage");
  });

  it("does not import the EOA-only utility", () => {
    // `import { verifyMessage } from "npm:viem@2"` is the trap: same name,
    // silently EOA-only.
    const rootImport = /import\s*\{[^}]*\bverifyMessage\b[^}]*\}\s*from\s*"npm:viem@2"/;
    expect(
      rootImport.test(LINK_WALLET),
      "the root viem verifyMessage is ecrecover-only — use the client action",
    ).toBe(false);
  });

  it("points its public client at Base, where the accounts live", () => {
    expect(LINK_WALLET).toMatch(/createPublicClient/);
    expect(LINK_WALLET).toMatch(/chain:\s*base/);
  });

  it("still never sends a transaction", () => {
    // A public client cannot sign, and it must stay that way. If a wallet
    // client or a private key ever appears in this function, the security
    // story on every screen that mentions it becomes false.
    expect(LINK_WALLET).not.toMatch(/createWalletClient|privateKeyToAccount|PRIVATE_KEY/);
  });
});

describe("wallet discovery", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  /** Announce a wallet the way an extension does. */
  const announce = (rdns: string, name: string) => {
    window.dispatchEvent(
      new CustomEvent("eip6963:announceProvider", {
        detail: {
          info: { uuid: `uuid-${rdns}`, name, icon: "data:image/svg+xml,x", rdns },
          provider: { request: async () => ["0x0000000000000000000000000000000000000001"] },
        },
      }),
    );
  };

  it("lists every wallet that announces, not just the last one to load", () => {
    const seen: string[][] = [];
    const stop = discoverWallets((ws) => seen.push(ws.map((w) => w.name)));

    announce("io.metamask", "MetaMask");
    announce("io.rabby", "Rabby");

    expect(seen.at(-1)).toEqual(["MetaMask", "Rabby"]);
    stop();
  });

  it("ignores a wallet announcing itself twice", () => {
    const seen: string[][] = [];
    const stop = discoverWallets((ws) => seen.push(ws.map((w) => w.id)));
    announce("io.metamask", "MetaMask");
    announce("io.metamask", "MetaMask");
    expect(seen.at(-1)).toEqual(["io.metamask"]);
    stop();
  });

  it("stops listening once unsubscribed", () => {
    const seen: string[][] = [];
    const stop = discoverWallets((ws) => seen.push(ws.map((w) => w.id)));
    stop();
    announce("io.rabby", "Rabby");
    expect(seen.at(-1)).toEqual([]);
  });

  it("skips a malformed announcement rather than throwing", () => {
    const seen: string[][] = [];
    const stop = discoverWallets((ws) => seen.push(ws.map((w) => w.id)));
    expect(() => {
      window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: {} }));
      window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: null }));
    }).not.toThrow();
    expect(seen.at(-1)).toEqual([]);
    stop();
  });

  it("falls back to an injected provider only when nothing announced", async () => {
    (window as unknown as Record<string, unknown>).ethereum = {
      request: async () => ["0x0000000000000000000000000000000000000002"],
    };
    const seen: string[][] = [];
    const stop = discoverWallets((ws) => seen.push(ws.map((w) => w.id)));
    await new Promise((r) => setTimeout(r, 420));
    expect(seen.at(-1)).toEqual(["injected"]);
    stop();
    delete (window as unknown as Record<string, unknown>).ethereum;
  });

  it("does not add the injected duplicate when a wallet announced", async () => {
    // MetaMask both announces AND writes window.ethereum. Listing it twice —
    // once by name, once as "Browser wallet" — is the obvious bug here.
    (window as unknown as Record<string, unknown>).ethereum = { request: async () => [] };
    const seen: string[][] = [];
    const stop = discoverWallets((ws) => seen.push(ws.map((w) => w.id)));
    announce("io.metamask", "MetaMask");
    await new Promise((r) => setTimeout(r, 420));
    expect(seen.at(-1)).toEqual(["io.metamask"]);
    stop();
    delete (window as unknown as Record<string, unknown>).ethereum;
  });

  it("complains in words when a wallet returns no accounts", async () => {
    await expect(requestAccount({ request: async () => [] })).rejects.toThrow(/no accounts/i);
  });
});
