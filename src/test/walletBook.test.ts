/**
 * The wallet book decides which address a token drop is sent to, which makes
 * it the one piece of client state where being subtly wrong costs somebody
 * real money. The failure modes are all quiet ones — a payout pointing at a
 * wallet that was removed, two entries for one address disagreeing about
 * which wallet proved it, a migration that drops the address somebody linked
 * last year — so they get assertions rather than trust.
 *
 * The module reads localStorage at import time and holds the book in a
 * module-level variable, so each test resets storage and re-imports.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const A = "0x7255EcF1020a95fEd5323dd4fEb23a54Ab1Aa7D1";
const B = "0xc3AD498815597f1E6f71D3cB1166856E947eFB46";
const C = "0x4200000000000000000000000000000000000006";

async function freshBook() {
  vi.resetModules();
  return import("@/lib/walletBook");
}

beforeEach(() => {
  localStorage.clear();
});

describe("the wallet book", () => {
  it("starts empty, with nothing to pay out to", async () => {
    const wb = await freshBook();
    expect(wb.getWalletBook().wallets).toEqual([]);
    expect(wb.getWalletBook().payout).toBeNull();
    expect(wb.payoutWallet()).toBeNull();
    expect(wb.hasWallets()).toBe(false);
  });

  it("adopts the single address the old keys held", async () => {
    /* Somebody who linked before the book existed has a proved address and no
       way to prove it again without another signature prompt. Losing it on
       upgrade would look exactly like being un-linked. */
    localStorage.setItem("vibe.payoutAddress.v1", A);
    localStorage.setItem("vibe.payoutKind.v1", "io.metamask");
    const wb = await freshBook();
    const book = wb.getWalletBook();
    expect(book.wallets).toHaveLength(1);
    expect(book.wallets[0].address).toBe(A);
    expect(book.wallets[0].label).toBe("MetaMask");
    expect(book.payout).toBe(A.toLowerCase());
  });

  it("ignores junk in the legacy key rather than booking it", async () => {
    localStorage.setItem("vibe.payoutAddress.v1", "not-an-address");
    const wb = await freshBook();
    expect(wb.getWalletBook().wallets).toEqual([]);
  });

  it("holds more than one, newest first, and pays out to the newest", async () => {
    const wb = await freshBook();
    wb.addWallet({ address: A, kind: "io.metamask" });
    wb.addWallet({ address: B, kind: "base" });
    const book = wb.getWalletBook();
    expect(book.wallets.map((w) => w.address)).toEqual([B, A]);
    // Somebody who just completed a signature prompt meant to use that one.
    expect(book.payout).toBe(B.toLowerCase());
  });

  it("re-links an address it already has instead of duplicating it", async () => {
    const wb = await freshBook();
    wb.addWallet({ address: A, kind: "injected", label: "Browser wallet" });
    wb.addWallet({ address: A.toLowerCase(), kind: "io.metamask", label: "MetaMask" });
    const book = wb.getWalletBook();
    expect(book.wallets).toHaveLength(1);
    expect(book.wallets[0].label).toBe("MetaMask");
  });

  it("normalises to a checksummed address, whatever case it arrives in", async () => {
    // Two rows for one address is just a confusing way of saying you can
    // reach it two ways, and it breaks every `includes` in the UI.
    const wb = await freshBook();
    wb.addWallet({ address: A.toLowerCase(), kind: "base" });
    expect(wb.getWalletBook().wallets[0].address).toBe(A);
  });

  it("refuses an address that is not one", async () => {
    const wb = await freshBook();
    wb.addWallet({ address: "0xnope", kind: "base" });
    expect(wb.getWalletBook().wallets).toEqual([]);
  });

  it("switches the payout without touching the list", async () => {
    const wb = await freshBook();
    wb.addWallet({ address: A, kind: "io.metamask" });
    wb.addWallet({ address: B, kind: "base" });
    wb.setPayoutWallet(A);
    expect(wb.getWalletBook().payout).toBe(A.toLowerCase());
    expect(wb.getWalletBook().wallets).toHaveLength(2);
    expect(wb.payoutWallet()?.address).toBe(A);
  });

  it("will not point the payout at a wallet it does not hold", async () => {
    const wb = await freshBook();
    wb.addWallet({ address: A, kind: "base" });
    wb.setPayoutWallet(C);
    expect(wb.getWalletBook().payout).toBe(A.toLowerCase());
  });

  it("promotes another wallet when the payout one is removed", async () => {
    /* The alternative is a book with wallets in it and no payout, which shows
       up as a blank "drops go to —" and reads as broken. */
    const wb = await freshBook();
    wb.addWallet({ address: A, kind: "io.metamask" });
    wb.addWallet({ address: B, kind: "base" });
    expect(wb.getWalletBook().payout).toBe(B.toLowerCase());
    wb.removeWallet(B);
    expect(wb.getWalletBook().wallets).toHaveLength(1);
    expect(wb.getWalletBook().payout).toBe(A.toLowerCase());
  });

  it("goes back to having no payout when the last wallet goes", async () => {
    const wb = await freshBook();
    wb.addWallet({ address: A, kind: "base" });
    wb.removeWallet(A);
    expect(wb.getWalletBook().payout).toBeNull();
    expect(wb.payoutWallet()).toBeNull();
    expect(localStorage.getItem("vibe.payoutAddress.v1")).toBeNull();
  });

  it("keeps the legacy key in step, so the chip and the page agree", async () => {
    // `readPayoutAddress` and anything else still reading the old key must not
    // be able to show a different address from the one this page highlights.
    const wb = await freshBook();
    wb.addWallet({ address: A, kind: "io.metamask" });
    wb.addWallet({ address: B, kind: "base" });
    expect(localStorage.getItem("vibe.payoutAddress.v1")).toBe(B);
    expect(localStorage.getItem("vibe.payoutKind.v1")).toBe("base");
    wb.setPayoutWallet(A);
    expect(localStorage.getItem("vibe.payoutAddress.v1")).toBe(A);
    expect(localStorage.getItem("vibe.payoutKind.v1")).toBe("io.metamask");
  });

  it("survives a reload", async () => {
    const wb = await freshBook();
    wb.addWallet({ address: A, kind: "io.metamask" });
    wb.addWallet({ address: B, kind: "base" });
    wb.setPayoutWallet(A);

    const reloaded = await freshBook();
    expect(reloaded.getWalletBook().wallets.map((w) => w.address)).toEqual([B, A]);
    expect(reloaded.getWalletBook().payout).toBe(A.toLowerCase());
  });

  it("repairs a stored payout that points nowhere", async () => {
    const wb = await freshBook();
    wb.addWallet({ address: A, kind: "base" });
    // Hand-edited, or written by a version that let the two drift.
    localStorage.setItem(
      "vibe.walletBook.v1",
      JSON.stringify({ wallets: wb.getWalletBook().wallets, payout: C.toLowerCase() }),
    );
    const reloaded = await freshBook();
    expect(reloaded.getWalletBook().payout).toBe(A.toLowerCase());
  });

  it("tells subscribers when anything moves", async () => {
    const wb = await freshBook();
    const seen: number[] = [];
    const off = wb.subscribeWalletBook((b) => seen.push(b.wallets.length));
    wb.addWallet({ address: A, kind: "base" });
    wb.addWallet({ address: B, kind: "io.metamask" });
    wb.removeWallet(A);
    off();
    wb.addWallet({ address: C, kind: "base" });
    expect(seen).toEqual([1, 2, 1]);
  });

  it("names the wallets it can, and takes the wallet's own word otherwise", async () => {
    const wb = await freshBook();
    expect(wb.labelForKind("base")).toBe("Vibe Wallet");
    expect(wb.labelForKind("io.metamask")).toBe("MetaMask");
    expect(wb.labelForKind("xyz.unknown", "Some Wallet")).toBe("Some Wallet");
    wb.addWallet({ address: A, kind: "xyz.unknown", label: "Frame" });
    expect(wb.getWalletBook().wallets[0].label).toBe("Frame");
  });

  it("knows which one the vibeverse made", async () => {
    const wb = await freshBook();
    wb.addWallet({ address: A, kind: "base" });
    wb.addWallet({ address: B, kind: "io.metamask" });
    const [meta, base] = wb.getWalletBook().wallets;
    expect(wb.isVibeWallet(base)).toBe(true);
    expect(wb.isVibeWallet(meta)).toBe(false);
  });
});
