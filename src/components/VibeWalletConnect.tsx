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
import { discoverWallets, requestAccount, type DiscoveredWallet } from "@/lib/wallets";

/** The address we last registered, so the UI can show it without a key. */
const ADDR_STORAGE = "vibe.payoutAddress.v1";
/** How that address was proven, purely so the card can say so later. */
const KIND_STORAGE = "vibe.payoutKind.v1";

export function readPayoutAddress(): string | null {
  try {
    return localStorage.getItem(ADDR_STORAGE);
  } catch {
    return null;
  }
}

/** Register a proven address against the community roster. */
async function registerAddress(
  address: Address,
  message: string,
  signature: string,
  displayName?: string,
  kind?: string,
) {
  const { data, error } = await supabase.functions.invoke("link-wallet", {
    body: { address, message, signature, display_name: displayName ?? null },
  });
  if (error) throw new Error(error.message);
  if (data?.error) throw new Error(String(data.error));
  try {
    localStorage.setItem(ADDR_STORAGE, address);
    if (kind) localStorage.setItem(KIND_STORAGE, kind);
  } catch {
    /* storage off — the server still has it, which is the copy that matters */
  }
  return data;
}

export default function VibeWalletConnect({
  displayName,
  onLinked,
}: {
  displayName?: string;
  onLinked?: (address: string) => void;
}) {
  const [address, setAddress] = useState<string | null>(readPayoutAddress);
  const [busy, setBusy] = useState<string | null>(null);
  const [installed, setInstalled] = useState<DiscoveredWallet[]>([]);
  const [showOthers, setShowOthers] = useState(false);
  const [passkeysOk, setPasskeysOk] = useState(true);

  useEffect(() => {
    setPasskeysOk(canUsePasskeys());
    return discoverWallets(setInstalled);
  }, []);

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
      await registerAddress(addr, message, signature, displayName, "base");
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
      await registerAddress(addr, message, signature, displayName, w.id);
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

  // ---- already linked ----------------------------------------------------
  if (address) {
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
          Where should your $VIBE go?
        </p>
      </div>
      <p className="mt-2 text-[11.5px] leading-relaxed text-muted-foreground">
        Optional, and not needed to play — the game runs on Vibecoin, which you
        already have. This is only the address a real $VIBE drop would be sent to.
      </p>

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
