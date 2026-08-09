/**
 * The test drop — proving the pipe by actually using it.
 *
 * `/wallet` could say "drops go here" and there was no way to find out whether
 * that was true. A payout address nobody has ever paid out to is a promise,
 * and the difference between a promise and a working system is one real
 * transaction. So: a button that sends a small amount of genuine $VIBE from
 * the vibeverse treasury to the wallet you linked, once, and gives you a
 * Basescan link to it.
 *
 * ## It is honest about not being switched on
 *
 * Every rule that matters lives in the `vibe-drop` edge function — the amount,
 * the one-per-address lock, the daily ceiling, the requirement that the
 * address was proved by a signature. This component only draws what that
 * function reports, which is why it can say "not switched on yet" rather than
 * showing a button that fails when pressed. Until a treasury key is set it
 * says so, in those words, and does not offer the button at all.
 *
 * The states it can be in, all of them from the server:
 *
 *   not armed        no treasury key — the honest default after deploying
 *   armed, unfunded  a key, but no $VIBE or no ETH for gas. Says which.
 *   ready            a button
 *   claimed          the tx hash, on Basescan
 */
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Check, ExternalLink, Loader2, Send } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";

interface DropStatus {
  armed: boolean;
  reason?: string;
  dropTokens: number;
  treasury?: string;
  treasuryVibe?: number | null;
  treasuryEth?: number | null;
  fundedForDrops?: boolean;
  fundedForGas?: boolean;
  dropsToday?: number;
  dropsPerDay?: number;
  claimed: boolean;
  txHash: string | null;
}

async function call<T>(action: string, address?: string): Promise<T> {
  const { data, error } = await supabase.functions.invoke("vibe-drop", {
    body: { action, address },
  });
  if (error) throw new Error(error.message);
  if (!data?.ok) throw new Error(data?.error ?? "vibe-drop error");
  return data.data as T;
}

export default function VibeTestDrop({
  address,
  onSent,
}: {
  address: string | null;
  /**
   * A drop landed. The wallet list above is showing balances read before it
   * happened, so it has to go and look again — otherwise the card says "1,000
   * $VIBE was sent to this wallet" directly beneath a row still reading the
   * old number, and the only way to see it arrive is a manual reload.
   */
  onSent?: () => void;
}) {
  const [status, setStatus] = useState<DropStatus | null>(null);
  const [sending, setSending] = useState(false);

  const load = useCallback(async () => {
    if (!address) return;
    try {
      setStatus(await call<DropStatus>("status", address));
    } catch {
      // A wallet page that works is more important than a drop panel that
      // does; if the function is unreachable, show nothing at all.
      setStatus(null);
    }
  }, [address]);

  useEffect(() => {
    void load();
  }, [load]);

  const send = useCallback(async () => {
    if (!address) return;
    setSending(true);
    try {
      const r = await call<{ txHash: string; amount: number }>("claim", address);
      toast.success(`${r.amount.toLocaleString()} $VIBE on the way`, {
        description: "A real transaction on Base. It lands in a few seconds.",
      });
      setStatus((s) => (s ? { ...s, claimed: true, txHash: r.txHash } : s));
      /* Twice, deliberately. Base confirms in about two seconds, but the RPC
         we read through can still answer from a block that predates the
         transfer — so ask once immediately for the responsive case and again
         a few seconds later for the true one. Cheap, and it is the difference
         between a number that moves on its own and a page you have to reload. */
      onSent?.();
      window.setTimeout(() => onSent?.(), 4000);
    } catch (e) {
      toast.error("The drop did not go", {
        description: String((e as Error)?.message ?? e),
      });
      void load();
    } finally {
      setSending(false);
    }
  }, [address, load, onSent]);

  if (!address || !status) return null;

  const amount = status.dropTokens.toLocaleString();

  return (
    <div className="mt-4 rounded-2xl border border-border/50 bg-black/25 p-4">
      <p className="font-heading text-[10px] font-black uppercase tracking-wider text-foreground/80">
        Test drop
      </p>

      {status.claimed && status.txHash ? (
        <>
          <p className="mt-2 flex items-center gap-1.5 text-[11.5px] leading-relaxed text-[#7dffd4]">
            <Check className="h-3.5 w-3.5 shrink-0" />
            {amount} $VIBE was sent to this wallet.
          </p>
          <a
            href={`https://basescan.org/tx/${status.txHash}`}
            target="_blank"
            rel="noreferrer noopener"
            className="mt-2 inline-flex items-center gap-1.5 font-mono text-[10.5px] text-[#8fb4ff] underline underline-offset-2 hover:text-[#b6cdff]"
          >
            {status.txHash.slice(0, 10)}…{status.txHash.slice(-8)}
            <ExternalLink className="h-3 w-3" />
          </a>
          <p className="mt-2 text-[10.5px] leading-relaxed text-muted-foreground/70">
            One per wallet, forever. That is the whole loop working: a ledger
            balance earned in a game, a wallet proved with a signature, and a
            real token arriving on chain.
          </p>
        </>
      ) : status.claimed ? (
        <p className="mt-2 text-[11.5px] leading-relaxed text-amber-300/85">
          A drop was claimed for this wallet but the send did not complete. It
          will not be retried automatically — a send that failed may still have
          been broadcast, and paying twice is worse than paying late.
        </p>
      ) : !status.armed ? (
        <>
          <p className="mt-2 text-[11.5px] leading-relaxed text-muted-foreground">
            Not switched on yet. The vibeverse can send you {amount} real $VIBE
            here as soon as there is a treasury wallet to send it from — one
            address holding $VIBE and a few dollars of ETH for gas, with its key
            set as <span className="font-mono text-foreground/70">VIBE_TREASURY_PRIVATE_KEY</span>.
          </p>
          <p className="mt-2 text-[10.5px] leading-relaxed text-muted-foreground/60">
            Nothing about this is live until that key exists — deploying the
            code did not arm it.
          </p>
        </>
      ) : !status.fundedForDrops || !status.fundedForGas ? (
        <p className="mt-2 text-[11.5px] leading-relaxed text-amber-300/85">
          The treasury is set up but{" "}
          {!status.fundedForDrops && !status.fundedForGas
            ? "holds neither $VIBE nor ETH for gas"
            : !status.fundedForDrops
              ? "is out of $VIBE"
              : "has no ETH for gas"}
          . Top it up and this becomes a button.
        </p>
      ) : (
        <>
          <p className="mt-2 text-[11.5px] leading-relaxed text-muted-foreground">
            Send yourself {amount} real $VIBE, on Base, from the vibeverse
            treasury. One per wallet — this is a proof that the pipe works, not
            a faucet.
          </p>
          <button
            onClick={() => void send()}
            disabled={sending}
            className="relative mt-3 flex w-full items-center justify-center gap-2 overflow-hidden rounded-xl bg-[#8fb4ff] px-3 py-2.5 font-heading text-[10.5px] font-black uppercase tracking-wider text-black transition-transform enabled:hover:scale-[1.02] disabled:opacity-90"
          >
            {/* Pressing this waits on a real transaction. A greyed-out button
                looks broken for those seconds; a sweep looks like something is
                happening, which is the truth. */}
            {sending && (
              <span
                aria-hidden
                className="pointer-events-none absolute inset-0 animate-[vibe-sweep_1.15s_linear_infinite]"
                style={{
                  background:
                    "linear-gradient(100deg, transparent 20%, rgba(255,255,255,0.65) 50%, transparent 80%)",
                }}
              />
            )}
            <span className="relative flex items-center gap-2">
              {sending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Send className="h-3.5 w-3.5" />
              )}
              {sending
                ? `Waiting on the vibe… ${amount} $VIBE incoming`
                : `Send ${amount} $VIBE to this wallet`}
            </span>
          </button>

          {status.dropsToday != null && status.dropsPerDay != null && (
            <p className="mt-1.5 text-center text-[10px] text-muted-foreground/60">
              {status.dropsPerDay - status.dropsToday} of today's{" "}
              {status.dropsPerDay} drops left
            </p>
          )}
        </>
      )}
    </div>
  );
}
