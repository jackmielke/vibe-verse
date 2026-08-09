/**
 * Where should your $VIBE go?
 *
 * ## Read this before changing anything here
 *
 * This component collects an **address to send a drop to**. It does not custody
 * anything, it never sends a transaction, and nothing in the vibeverse requires
 * it: rounds are staked in ledger Vibecoin, the shop spends ledger Vibecoin, and
 * somebody who never opens this card can play the entire event. The only thing
 * that leaves the browser is a signature over a sentence.
 *
 * ## Two doors, for two different people
 *
 * 1. **A Vibe Wallet** — a Base Account, made with a passkey. One Face ID
 *    prompt, no seed phrase, recovery through the platform's own keychain, and
 *    it is a real account that works in every other Base app. This is the
 *    default because it is the one a person who has never touched crypto can
 *    actually complete.
 * 2. **A wallet you already have** — every installed wallet, discovered over
 *    EIP-6963 and listed by name. Not "MetaMask": whatever they actually have.
 *
 * ## What used to be here, and why it is gone
 *
 * A third option generated a private key with viem and kept it in
 * `localStorage`. It was honest about being a mailing address rather than a
 * wallet, but it had no recovery of any kind — clearing your browser destroyed
 * it, permanently, with nobody to appeal to. Once the intent changed from
 * "somewhere to post a drop" to "your wallet", that became indefensible, so it
 * was removed rather than left as a tempting third button.
 */
import { useCallback, useEffect, useState } from "react";
import { Check, Loader2, ShieldCheck, Sparkles, Wallet } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { buildLinkMessage, shortAddress, type Address } from "@/lib/vibe-wallet";
import { canUsePasskeys, connectBaseAccount, signWithBaseAccount } from "@/lib/baseAccount";
import {
  authorizedAccount,
  discoverWallets,
  requestAccount,
  type DiscoveredWallet,
} from "@/lib/wallets";
import { addWallet, getWalletBook, readPayoutAddress } from "@/lib/walletBook";

/**
 * The payout address, for callers that only need the one string.
 *
 * Reads through the book, which keeps the legacy `vibe.payoutAddress.v1` key
 * in step — so this keeps working for anything that has not been moved over.
 * It is defined in `lib/walletBook.ts` now and re-exported here so old imports
 * keep resolving; import it from the book, not from this component, or you
 * take the Base Account SDK with it.
 */
export { readPayoutAddress };

/** Register a proven address against the community roster. */
async function registerAddress(
  address: Address,
  message: string,
  signature: string,
  displayName?: string,
  kind?: string,
  label?: string,
) {
  const { data, error } = await supabase.functions.invoke("link-wallet", {
    body: { address, message, signature, display_name: displayName ?? null },
  });
  if (error) throw new Error(error.message);
  if (data?.error) throw new Error(String(data.error));
  addWallet({ address, kind: kind ?? "injected", label });
  return data;
}

export default function VibeWalletConnect({
  displayName,
  onLinked,
  /**
   * Whether to collapse into "payout address set" once one exists.
   *
   * True on `/join`, where the card is a one-off step and a person who has
   * done it wants to see that they have. False on `/wallet`, where the list of
   * wallets is drawn above this and the card's whole job is *adding another* —
   * collapsing there is what made a second wallet unreachable.
   */
  showLinkedState = true,
}: {
  displayName?: string;
  onLinked?: (address: string) => void;
  showLinkedState?: boolean;
}) {
  const [address, setAddress] = useState<string | null>(readPayoutAddress);
  const [busy, setBusy] = useState<string | null>(null);
  const [installed, setInstalled] = useState<DiscoveredWallet[]>([]);
  /** rdns → the account that wallet has already granted this site. */
  const [known, setKnown] = useState<Record<string, Address>>({});
  const [showOthers, setShowOthers] = useState(false);
  const [passkeysOk, setPasskeysOk] = useState(true);

  useEffect(() => {
    setPasskeysOk(canUsePasskeys());
    return discoverWallets(setInstalled);
  }, []);

  /* Ask every discovered wallet, without prompting, whether it has already
     authorised this site. Somebody who connected MetaMask here before should
     be offered *that* wallet by name and address, rather than having to go
     looking for it behind "I already have a wallet". */
  useEffect(() => {
    let live = true;
    void Promise.all(
      installed.map(async (w) => [w.id, await authorizedAccount(w.provider)] as const),
    ).then((pairs) => {
      if (!live) return;
      const next: Record<string, Address> = {};
      const booked = new Set(
        getWalletBook().wallets.map((b) => b.address.toLowerCase()),
      );
      for (const [id, addr] of pairs) {
        // Only worth surfacing if it is not already in the book — otherwise
        // the page offers to link something it is already showing.
        if (addr && !booked.has(addr.toLowerCase())) next[id] = addr;
      }
      setKnown(next);
    });
    return () => {
      live = false;
    };
  }, [installed, address]);

  const finish = useCallback(
    (addr: Address) => {
      setAddress(addr);
      onLinked?.(addr);
      toast.success("Wallet linked", {
        description: `${shortAddress(addr)} is where your $VIBE will go.`,
      });
    },
    [onLinked],
  );

  /** Door 1 — make (or open) a Base Account with a passkey. */
  const useVibeWallet = async () => {
    setBusy("base");
    try {
      const addr = await connectBaseAccount();
      const message = buildLinkMessage({ address: addr, community: "the Vibeverse" });
      const signature = await signWithBaseAccount(addr, message);
      await registerAddress(addr, message, signature, displayName, "base", "Vibe Wallet");
      finish(addr);
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      // Closing the passkey sheet is a decision, not a failure.
      if (!/user rejected|denied|closed|cancel|4001/i.test(msg)) {
        toast.error("Could not set up your Vibe Wallet", { description: msg });
      }
    } finally {
      setBusy(null);
    }
  };

  /** Door 2 — a wallet they already have, whichever one it is. */
  const useInstalled = async (w: DiscoveredWallet) => {
    setBusy(w.id);
    try {
      const addr = await requestAccount(w.provider);
      const message = buildLinkMessage({ address: addr, community: "the Vibeverse" });
      const signature = (await w.provider.request({
        method: "personal_sign",
        params: [message, addr],
      })) as string;
      await registerAddress(addr, message, signature, displayName, w.id, w.name);
      finish(addr);
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      if (!/user rejected|denied|4001/i.test(msg)) {
        toast.error(`Could not link ${w.name}`, { description: msg });
      }
    } finally {
      setBusy(null);
    }
  };

  /* Wallets that have already granted this site an account. These jump the
     queue: they are one signature away, and they are the answer to "I already
     have a wallet, why are you asking me to make one". */
  const ready = installed.filter((w) => known[w.id]);

  // ---- already linked ----------------------------------------------------
  if (address && showLinkedState) {
    return (
      <div className="rounded-2xl border border-[#7dffd4]/30 bg-[#7dffd4]/[0.06] p-4">
        <div className="flex items-center gap-2.5">
          <Check className="h-4 w-4 shrink-0 text-[#7dffd4]" />
          <div className="min-w-0">
            <p className="font-heading text-[11px] font-black uppercase tracking-wider text-[#7dffd4]">
              Payout address set
            </p>
            <p className="mt-0.5 truncate font-mono text-[11px] text-foreground/75">
              {shortAddress(address as Address)}
            </p>
          </div>
        </div>
        <p className="mt-2.5 text-[11px] leading-relaxed text-muted-foreground">
          This is where your $VIBE gets sent when the drop happens. Nothing is
          held here and nothing leaves your wallet — you only ever signed a
          message.
        </p>
      </div>
    );
  }

  // ---- the chooser -------------------------------------------------------
  return (
    <div className="rounded-2xl border border-border/50 bg-black/28 p-4">
      <div className="flex items-center gap-2">
        <Wallet className="h-4 w-4 shrink-0 text-[#8fb4ff]" />
        <p className="font-heading text-[11px] font-black uppercase tracking-wider text-[#8fb4ff]">
          {address ? "Add another wallet" : "Where should your $VIBE go?"}
        </p>
      </div>
      <p className="mt-2 text-[11.5px] leading-relaxed text-muted-foreground">
        Optional, and not needed to play — the game runs on Vibecoin, which you
        already have. This is only the address a real $VIBE drop would be sent to.
      </p>

      {/* The fast path: a wallet that has already authorised this site, named
          and with the address it would link, so there is nothing to work out. */}
      {ready.length > 0 && (
        <div className="mt-3.5 flex flex-col gap-2">
          {ready.map((w) => (
            <button
              key={w.id}
              onClick={() => void useInstalled(w)}
              disabled={busy != null}
              className="flex items-center gap-2.5 rounded-xl border border-[#7dffd4]/40 bg-[#7dffd4]/[0.07] px-3 py-2.5 text-left transition-colors enabled:hover:bg-[#7dffd4]/[0.12] disabled:opacity-50"
            >
              {busy === w.id ? (
                <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
              ) : w.icon ? (
                <img src={w.icon} alt="" className="h-4 w-4 shrink-0 rounded" />
              ) : (
                <Wallet className="h-4 w-4 shrink-0 text-[#7dffd4]" />
              )}
              <span className="min-w-0 flex-1">
                <span className="block font-heading text-[10.5px] font-black uppercase tracking-wider text-[#7dffd4]">
                  Link your {w.name}
                </span>
                <span className="mt-0.5 block truncate font-mono text-[10px] text-muted-foreground">
                  {shortAddress(known[w.id])} · already connected here
                </span>
              </span>
            </button>
          ))}
        </div>
      )}

      <div className="mt-3.5 flex flex-col gap-2">
        <button
          onClick={() => void useVibeWallet()}
          disabled={busy != null || !passkeysOk}
          className="flex items-center justify-center gap-2 rounded-xl bg-[#8fb4ff] px-3 py-3 font-heading text-[10.5px] font-black uppercase tracking-wider text-black transition-transform enabled:hover:scale-[1.02] disabled:opacity-50"
        >
          {busy === "base" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Sparkles className="h-3.5 w-3.5" />
          )}
          Create a Vibe Wallet
        </button>
        <p className="px-1 text-[10.5px] leading-relaxed text-muted-foreground/70">
          {passkeysOk ? (
            <>
              A real wallet on Base, made with Face&nbsp;ID or your fingerprint —
              no seed phrase to write down, and it works in every other Base app.
              Takes one tap.
            </>
          ) : (
            <>
              This browser cannot make a passkey wallet — it needs a secure
              connection and a device that supports Face&nbsp;ID, a fingerprint
              or a PIN. Use a wallet you already have instead.
            </>
          )}
        </p>

        {/* Door 2, collapsed. Somebody who already owns a wallet recognises
            this line instantly; somebody who does not should not be made to
            read a list of extensions they have never heard of. */}
        {!showOthers ? (
          <button
            onClick={() => setShowOthers(true)}
            className="mt-1 rounded-xl border border-border/60 px-3 py-2.5 font-heading text-[10px] font-black uppercase tracking-wider text-foreground/80 transition-colors hover:border-foreground/40 hover:text-foreground"
          >
            I already have a wallet
          </button>
        ) : installed.length ? (
          <div className="mt-1 flex flex-col gap-2">
            {installed.map((w) => (
              <button
                key={w.id}
                onClick={() => void useInstalled(w)}
                disabled={busy != null}
                className="flex items-center gap-2.5 rounded-xl border border-border/60 px-3 py-2.5 text-left transition-colors enabled:hover:border-foreground/40 disabled:opacity-50"
              >
                {busy === w.id ? (
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
                ) : w.icon ? (
                  <img src={w.icon} alt="" className="h-4 w-4 shrink-0 rounded" />
                ) : (
                  <Wallet className="h-4 w-4 shrink-0 text-muted-foreground" />
                )}
                <span className="font-heading text-[10.5px] font-black uppercase tracking-wider text-foreground/85">
                  {w.name}
                </span>
              </button>
            ))}
          </div>
        ) : (
          <p className="mt-1 rounded-xl border border-border/50 px-3 py-2.5 text-[11px] leading-relaxed text-muted-foreground/75">
            No wallet extension found in this browser. Install one — MetaMask,
            Rabby, Coinbase Wallet, whichever you like — or make a Vibe Wallet
            above, which needs nothing installed.
          </p>
        )}
      </div>

      <div className="mt-3.5 flex items-start gap-2 border-t border-border/40 pt-3">
        <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
        <p className="text-[10.5px] leading-relaxed text-muted-foreground/60">
          Either way you sign a sentence, never a transaction. We never see a
          key and nothing moves out of your wallet.
        </p>
      </div>
    </div>
  );
}
