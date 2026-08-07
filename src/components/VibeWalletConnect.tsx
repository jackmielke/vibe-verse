/**
 * Where should your $VIBE go?
 *
 * ## Read this before changing anything here
 *
 * This component collects an **address to send an airdrop to**. It is not a
 * hot wallet, it does not custody anything, and nothing in the vibeverse
 * requires it: rounds are staked in ledger Vibecoin, the shop spends ledger
 * Vibecoin, and a person who never touches this page can play the entire event.
 *
 * That distinction is the only reason "make me a wallet" is a responsible
 * button to offer. A generated key that is never asked to hold value during the
 * event is a mailing address; the same key guarding somebody's savings would be
 * a bad idea implemented by a game studio.
 *
 * Two ways in:
 *
 * 1. **A wallet you already have.** MetaMask, Rabby, Coinbase Wallet, anything
 *    EIP-1193. You sign a message, the server verifies the signature, done —
 *    no transaction, no approval, no funds move.
 * 2. **One made here.** A keypair generated in your browser, which signs the
 *    same proof immediately. The key is shown once and stored in this browser,
 *    and the copy says exactly that in plain words. It is a starter address for
 *    receiving a drop, and it says to export it into a real wallet before it
 *    holds anything that matters.
 *
 * What is deliberately NOT here: any flow that takes a seed phrase, any custody
 * of a key on our servers, and any suggestion that the generated wallet is as
 * safe as a real one.
 */
import { useEffect, useState } from "react";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { Check, Copy, Download, Loader2, ShieldAlert, Wallet } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import {
  buildLinkMessage,
  connectWallet,
  hasWallet,
  shortAddress,
  signLinkMessage,
  type Address,
} from "@/lib/vibe-wallet";

/** Where the browser-made key lives. Named so it is obvious in devtools. */
const KEY_STORAGE = "vibe.starterWallet.v1";
/** The address we last registered, so the UI can show it without the key. */
const ADDR_STORAGE = "vibe.payoutAddress.v1";

interface StarterWallet {
  address: string;
  privateKey: string;
  createdAt: number;
}

export function readStarterWallet(): StarterWallet | null {
  try {
    const raw = localStorage.getItem(KEY_STORAGE);
    return raw ? (JSON.parse(raw) as StarterWallet) : null;
  } catch {
    return null;
  }
}

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
) {
  const { data, error } = await supabase.functions.invoke("link-wallet", {
    body: { address, message, signature, display_name: displayName ?? null },
  });
  if (error) throw new Error(error.message);
  if (data?.error) throw new Error(String(data.error));
  try {
    localStorage.setItem(ADDR_STORAGE, address);
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
  const [busy, setBusy] = useState<"browser" | "create" | null>(null);
  const [reveal, setReveal] = useState<StarterWallet | null>(null);
  const [copied, setCopied] = useState(false);
  const [extension, setExtension] = useState(false);

  useEffect(() => setExtension(hasWallet()), []);

  const linkBrowserWallet = async () => {
    setBusy("browser");
    try {
      const addr = await connectWallet();
      const session = await signLinkMessage(addr, "the Vibeverse");
      await registerAddress(addr, session.message, session.signature, displayName);
      setAddress(addr);
      onLinked?.(addr);
      toast.success("Wallet linked", {
        description: `${shortAddress(addr)} is where your $VIBE will go.`,
      });
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      // Cancelling is not an error worth a red toast.
      if (!/user rejected|denied|4001/i.test(msg)) {
        toast.error("Could not link that wallet", { description: msg });
      }
    } finally {
      setBusy(null);
    }
  };

  const createWallet = async () => {
    setBusy("create");
    try {
      const pk = generatePrivateKey();
      const account = privateKeyToAccount(pk);
      const message = buildLinkMessage({ address: account.address, community: "the Vibeverse" });
      // Signed right here, with the key we just made — the server sees exactly
      // the same proof a MetaMask user provides and cannot tell the difference,
      // which is the point.
      const signature = await account.signMessage({ message });
      await registerAddress(account.address, message, signature, displayName);

      const wallet: StarterWallet = {
        address: account.address,
        privateKey: pk,
        createdAt: Date.now(),
      };
      try {
        localStorage.setItem(KEY_STORAGE, JSON.stringify(wallet));
      } catch {
        /* If storage is off the key exists only in the reveal below, which is
           why the reveal is mandatory rather than a "show key" affordance. */
      }
      setReveal(wallet);
      setAddress(account.address);
      onLinked?.(account.address);
    } catch (e) {
      toast.error("Could not make a wallet", {
        description: String((e as Error)?.message ?? e),
      });
    } finally {
      setBusy(null);
    }
  };

  const copyKey = async () => {
    if (!reveal) return;
    try {
      await navigator.clipboard.writeText(reveal.privateKey);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Could not copy — select the key and copy it by hand.");
    }
  };

  const downloadKey = () => {
    if (!reveal) return;
    const body =
      `Vibeverse starter wallet\n\n` +
      `Address:     ${reveal.address}\n` +
      `Private key: ${reveal.privateKey}\n\n` +
      `Anyone with this key controls this address. Keep the file somewhere private.\n` +
      `To use it in a real wallet: MetaMask > Add account > Import > paste the key.\n`;
    const url = URL.createObjectURL(new Blob([body], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `vibeverse-wallet-${reveal.address.slice(0, 8)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // ---- linked ------------------------------------------------------------
  if (address && !reveal) {
    return (
      <div className="rounded-2xl border border-[#7dffd4]/30 bg-[#7dffd4]/[0.06] p-4">
        <div className="flex items-center gap-2.5">
          <Check className="h-4 w-4 shrink-0 text-[#7dffd4]" />
          <div className="min-w-0">
            <p className="font-heading text-[11px] font-black uppercase tracking-wider text-[#7dffd4]">
              Payout address set
            </p>
            <p className="mt-0.5 truncate font-mono text-[11px] text-foreground/75">
              {shortAddress(address)}
            </p>
          </div>
        </div>
        <p className="mt-2.5 text-[11px] leading-relaxed text-muted-foreground">
          This is where your $VIBE gets sent when the drop happens. Nothing is held
          here and nothing leaves your wallet — you only ever signed a message.
        </p>
      </div>
    );
  }

  // ---- the key, once -----------------------------------------------------
  if (reveal) {
    return (
      <div className="rounded-2xl border border-amber-400/40 bg-amber-400/[0.06] p-4">
        <div className="flex items-center gap-2">
          <ShieldAlert className="h-4 w-4 shrink-0 text-amber-300" />
          <p className="font-heading text-[11px] font-black uppercase tracking-wider text-amber-300">
            Save this now — it is shown once
          </p>
        </div>
        <p className="mt-2 text-[11.5px] leading-relaxed text-foreground/80">
          Anyone holding this key controls the address. It is kept in this browser
          so the drop can reach you, which means clearing your history loses it.
          Copy it somewhere safe, and import it into a real wallet before you keep
          anything valuable there.
        </p>

        <p className="mt-3 font-heading text-[8.5px] font-bold uppercase tracking-[0.2em] text-muted-foreground">
          Address
        </p>
        <p className="truncate font-mono text-[11px] text-foreground/85">{reveal.address}</p>

        <p className="mt-2.5 font-heading text-[8.5px] font-bold uppercase tracking-[0.2em] text-muted-foreground">
          Private key
        </p>
        <p className="break-all rounded-lg border border-border/50 bg-black/45 p-2 font-mono text-[10.5px] leading-relaxed text-amber-100/90">
          {reveal.privateKey}
        </p>

        <div className="mt-3 flex flex-wrap gap-2">
          <button
            onClick={() => void copyKey()}
            className="flex items-center gap-1.5 rounded-lg border border-border/60 px-3 py-2 font-heading text-[9.5px] font-bold uppercase tracking-wider text-foreground/85 transition-colors hover:text-foreground"
          >
            {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
            {copied ? "Copied" : "Copy key"}
          </button>
          <button
            onClick={downloadKey}
            className="flex items-center gap-1.5 rounded-lg border border-border/60 px-3 py-2 font-heading text-[9.5px] font-bold uppercase tracking-wider text-foreground/85 transition-colors hover:text-foreground"
          >
            <Download className="h-3 w-3" />
            Download
          </button>
          <button
            onClick={() => setReveal(null)}
            className="ml-auto rounded-lg bg-amber-300 px-3 py-2 font-heading text-[9.5px] font-black uppercase tracking-wider text-black transition-transform hover:scale-[1.02]"
          >
            I have saved it
          </button>
        </div>
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
          onClick={() => void linkBrowserWallet()}
          disabled={busy != null}
          className="flex items-center justify-center gap-2 rounded-xl border border-border/60 px-3 py-2.5 font-heading text-[10px] font-black uppercase tracking-wider text-foreground/90 transition-colors hover:border-foreground/40 disabled:opacity-50"
        >
          {busy === "browser" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "🦊"}
          {extension ? "Use my wallet" : "Use a wallet extension"}
        </button>
        {!extension && (
          <p className="-mt-1 px-1 text-[10.5px] text-muted-foreground/70">
            No wallet detected in this browser — the button will tell you what to
            install, or make one below instead.
          </p>
        )}

        <button
          onClick={() => void createWallet()}
          disabled={busy != null}
          className="flex items-center justify-center gap-2 rounded-xl bg-[#8fb4ff] px-3 py-2.5 font-heading text-[10px] font-black uppercase tracking-wider text-black transition-transform enabled:hover:scale-[1.02] disabled:opacity-50"
        >
          {busy === "create" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "✨"}
          Make me one
        </button>
        <p className="px-1 text-[10.5px] leading-relaxed text-muted-foreground/70">
          Makes a fresh address in this browser and shows you the key once. Good for
          receiving a drop; export it into a real wallet before it holds anything
          you would miss.
        </p>
      </div>
    </div>
  );
}
