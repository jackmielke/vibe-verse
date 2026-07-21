/**
 * VibeShopPanel — buy demo items with $VIBE.
 *
 * Each item unlocks a cosmetic hat that's tied to the paying wallet.
 * Payments go direct on-chain to MERCHANT_ADDRESS (no custody, no backend).
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

// Where $VIBE payments go.
const MERCHANT_ADDRESS: Address = "0x6bDa0Bd9D8AE76dE24b9C2F7Be9ab2D4b3b888a5";

type Item = {
  id: string;
  name: string;
  blurb: string;
  emoji: string;
  priceVibe: number;
  hatId: string;
  hatName: string;
  accent: string; // hsl triplet for gradient tint
};

// Catalog. Each item's `hatId` must exist in HAT_CATALOG so it can be
// equipped in-game right after purchase.
const ITEMS: Item[] = [
  {
    id: "sticker",
    name: "Holo Sticker Pack",
    blurb: "Limited holographic stickers + the Holo Sticker Hat unlock.",
    emoji: "✨",
    priceVibe: 100,
    hatId: "sticker",
    hatName: "Holo Sticker Hat",
    accent: "150 80% 60%",
  },
  {
    id: "cap",
    name: "Mint Cap Drop",
    blurb: "Our house colorway on a curved-brim cap. Fits every character.",
    emoji: "🧢",
    priceVibe: 60,
    hatId: "cap",
    hatName: "Mint Cap",
    accent: "160 80% 55%",
  },
  {
    id: "party",
    name: "Party Cone",
    blurb: "For plaza dance-offs and impromptu birthday parties.",
    emoji: "🥳",
    priceVibe: 120,
    hatId: "party",
    hatName: "Party Cone",
    accent: "200 90% 65%",
  },
  {
    id: "propeller",
    name: "Propeller Beanie",
    blurb: "Spins while you fly. Certified goofy-mode gear.",
    emoji: "🚁",
    priceVibe: 180,
    hatId: "propeller",
    hatName: "Propeller Hat",
    accent: "0 80% 65%",
  },
  {
    id: "crown",
    name: "Cardboard Crown",
    blurb: "Rule Vibe Island in style. Gold-plated, gem-tipped.",
    emoji: "👑",
    priceVibe: 500,
    hatId: "crown",
    hatName: "Crown",
    accent: "45 95% 60%",
  },
  {
    id: "halo",
    name: "Halo of the Vibe",
    blurb: "Ultra-rare. Floats above your head with divine glow.",
    emoji: "😇",
    priceVibe: 800,
    hatId: "halo",
    hatName: "Halo",
    accent: "50 100% 75%",
  },
];

function toVibeUnits(amount: number): bigint {
  const [whole, frac = ""] = String(amount).split(".");
  const fracPadded = (frac + "000000000000000000").slice(0, 18);
  return BigInt(whole) * 10n ** 18n + BigInt(fracPadded || "0");
}

export default function VibeShopPanel() {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [unlocked, setUnlocked] = useState<{ item: Item; hash: string; account: Address } | null>(null);

  async function handleBuy(item: Item) {
    if (busyId) return;
    setBusyId(item.id);
    try {
      const from = await connectWallet();
      const hash = await sendVibe({
        from,
        to: MERCHANT_ADDRESS,
        amount: toVibeUnits(item.priceVibe),
      });
      unlockHat(item.hatId, from);
      try { localStorage.setItem("city.hat", item.hatId); } catch { /* ignore */ }
      setUnlocked({ item, hash, account: from });
      const url = `https://basescan.org/tx/${hash}`;
      toast.success(`🎩 ${item.hatName} unlocked!`, {
        description: `Equipped automatically. Strut into /city to show it off.`,
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
      if (/reject|denied|user/i.test(msg)) {
        toast("Payment cancelled");
      } else {
        toast.error("Couldn't send payment", { description: msg });
      }
    } finally {
      setBusyId(null);
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

      <div className="grid gap-3 sm:grid-cols-2">
        {ITEMS.map((item) => {
          const busy = busyId === item.id;
          return (
            <div
              key={item.id}
              className="flex flex-col gap-3 rounded-xl border border-border/60 bg-background/30 p-4"
            >
              <div className="flex items-start gap-3">
                <div
                  className="shrink-0 w-14 h-14 rounded-xl flex items-center justify-center text-2xl"
                  style={{
                    background: `linear-gradient(135deg, hsl(${item.accent} / 0.28), hsl(280 80% 60% / 0.15))`,
                    border: `1px solid hsl(${item.accent} / 0.4)`,
                  }}
                  aria-hidden
                >
                  {item.emoji}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-heading text-sm font-semibold text-foreground leading-tight">
                    {item.name}
                  </p>
                  <p className="text-[11px] text-muted-foreground leading-snug mt-1">
                    {item.blurb}
                  </p>
                </div>
              </div>
              <div className="flex items-center justify-between gap-2 mt-auto">
                <p className="text-sm font-mono text-primary">
                  {item.priceVibe.toLocaleString()} ${VIBE_TOKEN_SYMBOL}
                </p>
                <button
                  type="button"
                  onClick={() => handleBuy(item)}
                  disabled={!!busyId}
                  className="rounded-lg px-3 py-2 font-heading font-semibold text-xs tracking-wide uppercase bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-60 disabled:cursor-not-allowed transition-colors flex items-center gap-1.5"
                >
                  {busy ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      Confirm…
                    </>
                  ) : (
                    <>
                      <Sparkles className="w-3.5 h-3.5" />
                      Buy
                    </>
                  )}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {unlocked && (
        <div
          className="rounded-xl border p-4 flex flex-col gap-3 animate-in fade-in slide-in-from-bottom-2"
          style={{
            borderColor: "hsl(150 80% 60% / 0.55)",
            background:
              "linear-gradient(135deg, hsl(280 80% 60% / 0.18), hsl(150 80% 60% / 0.18))",
            boxShadow: "0 0 24px hsl(150 80% 60% / 0.25)",
          }}
        >
          <div className="flex items-center gap-2">
            <span className="text-2xl" aria-hidden>🎩✨</span>
            <div className="flex-1 min-w-0">
              <p className="font-heading font-semibold text-sm text-foreground">
                {unlocked.item.hatName} unlocked
              </p>
              <p className="text-[11px] text-muted-foreground leading-snug">
                Tied to {shortAddress(unlocked.account)} — auto-equipped on your avatar.
              </p>
            </div>
          </div>
          <a
            href="/city"
            className="w-full rounded-lg px-3 py-2 text-center text-xs font-heading font-semibold uppercase tracking-wide bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            Strut into /city →
          </a>
        </div>
      )}

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
