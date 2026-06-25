/**
 * VibeShopPanel — buy a demo item with $VIBE.
 *
 * Flow:
 *   1. User clicks "Buy with $VIBE"
 *   2. We pop MetaMask (or any EIP-1193 wallet) via `connectWallet()`,
 *      which also switches them to Base.
 *   3. We build an ERC-20 transfer to MERCHANT_ADDRESS and ask the
 *      wallet to sign + broadcast via `sendVibe()`.
 *   4. Toast with a link to the tx on BaseScan.
 *
 * No backend, no order log — just a real on-chain payment.
 */
import { useState } from "react";
import { Loader2, ShoppingBag, ExternalLink, Sparkles } from "lucide-react";
import { toast } from "sonner";
import {
  connectWallet,
  sendVibe,
  shortAddress,
  VIBE_TOKEN_SYMBOL,
  type Address,
} from "@/lib/vibe-wallet";
import { unlockHat } from "@/components/city/cosmetics";

// Hat cosmetic granted by buying the sticker pack.
const REWARD_HAT_ID = "sticker";
const REWARD_HAT_NAME = "Holo Sticker Hat";

// Where $VIBE payments go. Configurable here so it's obvious.
const MERCHANT_ADDRESS: Address = "0x6bDa0Bd9D8AE76dE24b9C2F7Be9ab2D4b3b888a5";

// The single demo item. Bump these or swap the copy any time.
const ITEM = {
  name: "Vibe Sticker Pack",
  blurb:
    "A limited holographic sticker pack — pay in $VIBE, claim it next time we see you IRL.",
  emoji: "✨",
  priceVibe: 100,
};

// 18 decimals — same as `VIBE_TOKEN_DECIMALS`. Inlined here so we
// don't need a separate import; the helper expects a `bigint` already
// scaled to the token's smallest unit.
function toVibeUnits(amount: number): bigint {
  // Split into integer + fractional so we don't lose precision on
  // weird floats (100.1 etc).
  const [whole, frac = ""] = String(amount).split(".");
  const fracPadded = (frac + "000000000000000000").slice(0, 18);
  return BigInt(whole) * 10n ** 18n + BigInt(fracPadded || "0");
}

export default function VibeShopPanel() {
  const [busy, setBusy] = useState(false);

  async function handleBuy() {
    if (busy) return;
    setBusy(true);
    try {
      const from = await connectWallet();
      const hash = await sendVibe({
        from,
        to: MERCHANT_ADDRESS,
        amount: toVibeUnits(ITEM.priceVibe),
      });
      const url = `https://basescan.org/tx/${hash}`;
      toast.success(`Payment sent! ${ITEM.priceVibe} $VIBE on the way.`, {
        description: `From ${shortAddress(from)} → ${shortAddress(MERCHANT_ADDRESS)}`,
        action: {
          label: "View tx",
          onClick: () => window.open(url, "_blank", "noopener,noreferrer"),
        },
        duration: 10_000,
      });
    } catch (err) {
      const msg =
        (err as { shortMessage?: string; message?: string })?.shortMessage ||
        (err as { message?: string })?.message ||
        "Transaction failed";
      // User-rejected sigs are noisy — soften them.
      if (/reject|denied|user/i.test(msg)) {
        toast("Payment cancelled");
      } else {
        toast.error("Couldn't send payment", { description: msg });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="glass-panel rounded-2xl border border-primary/30 p-5 flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <ShoppingBag className="w-4 h-4 text-primary" />
        <p className="text-[10px] font-heading font-semibold tracking-widest uppercase text-primary">
          Vibe Shop · Beta
        </p>
      </div>

      <div className="flex items-center gap-4 rounded-xl border border-border/60 bg-background/30 p-4">
        <div
          className="shrink-0 w-16 h-16 rounded-xl flex items-center justify-center text-3xl"
          style={{
            background:
              "linear-gradient(135deg, hsl(150 80% 60% / 0.25), hsl(280 80% 60% / 0.15))",
            border: "1px solid hsl(150 80% 60% / 0.35)",
          }}
          aria-hidden
        >
          {ITEM.emoji}
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-heading text-base font-semibold text-foreground">
            {ITEM.name}
          </p>
          <p className="text-xs text-muted-foreground leading-snug mt-0.5">
            {ITEM.blurb}
          </p>
          <p className="mt-2 text-sm font-mono text-primary">
            {ITEM.priceVibe.toLocaleString()} ${VIBE_TOKEN_SYMBOL}
          </p>
        </div>
      </div>

      <button
        type="button"
        onClick={handleBuy}
        disabled={busy}
        className="w-full rounded-xl px-4 py-3 font-heading font-semibold text-sm tracking-wide uppercase bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-60 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
      >
        {busy ? (
          <>
            <Loader2 className="w-4 h-4 animate-spin" />
            Confirm in wallet…
          </>
        ) : (
          <>
            <Sparkles className="w-4 h-4" />
            Buy with ${VIBE_TOKEN_SYMBOL}
          </>
        )}
      </button>

      <p className="text-[10px] text-muted-foreground/80 leading-relaxed">
        Opens MetaMask (or any browser wallet) on Base. Pays{" "}
        <a
          href={`https://basescan.org/address/${MERCHANT_ADDRESS}`}
          target="_blank"
          rel="noreferrer"
          className="text-primary hover:underline inline-flex items-center gap-0.5"
        >
          {shortAddress(MERCHANT_ADDRESS)} <ExternalLink className="w-2.5 h-2.5" />
        </a>{" "}
        directly — no middleman, no custody, no funds ever touch this app.
      </p>
    </div>
  );
}
