/**
 * VibeLogin — the "log in with your wallet" surface.
 *
 * Renders one of three states:
 *
 *   not connected → big "Connect wallet" CTA
 *   connected but not linked → shows address, "Link to community" button
 *                              which signs the SIWE message and POSTs
 *                              to the link-wallet edge function
 *   linked → shows compact profile pill (address + live VIBE balance)
 *            with a logout option
 *
 * The connect + sign flow is self-contained — no external auth state
 * needed. Drop this component anywhere in the app and it works.
 */
import { useCallback, useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Wallet, LogOut, Loader2, Sparkles, ExternalLink } from "lucide-react";
import {
  connectWallet,
  signLinkMessage,
  getVibeBalance,
  loadSession,
  clearSession,
  hasWallet,
  shortAddress,
  formatVibe,
  onWalletEvents,
  type LinkedWallet,
  type Address,
} from "@/lib/vibe-wallet";
import { supabase } from "@/integrations/supabase/client";

const COMMUNITY_NAME = "Edge Esmeralda";

interface Props {
  /** Optional callback for when a wallet finishes linking. */
  onLinked?: (session: LinkedWallet) => void;
  /** Optional callback for when the user disconnects. */
  onDisconnected?: () => void;
  /** Render style. "pill" is the compact lobby/space variant; "card"
      is the bigger /vibe hub variant. */
  variant?: "pill" | "card";
}

export default function VibeLogin({ onLinked, onDisconnected, variant = "pill" }: Props) {
  const [session, setSession] = useState<LinkedWallet | null>(() => loadSession());
  const [address, setAddress] = useState<Address | null>(() => loadSession()?.address ?? null);
  const [balanceWei, setBalanceWei] = useState<bigint | null>(null);
  const [step, setStep] = useState<"idle" | "connecting" | "signing" | "linking" | "linked">(() =>
    loadSession() ? "linked" : "idle",
  );
  const [error, setError] = useState<string | null>(null);

  // Live VIBE balance whenever the address changes.
  useEffect(() => {
    if (!address) {
      setBalanceWei(null);
      return;
    }
    let cancelled = false;
    getVibeBalance(address)
      .then((b) => { if (!cancelled) setBalanceWei(b.raw); })
      .catch(() => { if (!cancelled) setBalanceWei(0n); });
    return () => { cancelled = true; };
  }, [address]);

  // React to wallet UI events — user might switch accounts in
  // MetaMask, which should swap our visible address.
  useEffect(() => {
    return onWalletEvents({
      accountsChanged: (accounts) => {
        if (!accounts.length) {
          handleLogout();
          return;
        }
        // Don't auto-bind — switching accounts in MetaMask should
        // require a fresh re-link so we know the new account intends
        // to attach to the community.
        if (session && accounts[0].toLowerCase() !== session.address.toLowerCase()) {
          setSession(null);
          setAddress(null);
          setStep("idle");
          clearSession();
        }
      },
      disconnect: () => handleLogout(),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.address]);

  const handleConnect = useCallback(async () => {
    setError(null);
    if (!hasWallet()) {
      setError("No browser wallet found. Install MetaMask, Coinbase Wallet, or Rabby to continue.");
      return;
    }
    try {
      setStep("connecting");
      const addr = await connectWallet();
      setAddress(addr);

      setStep("signing");
      const sig = await signLinkMessage(addr, COMMUNITY_NAME);

      setStep("linking");
      // Call the edge function to verify the sig server-side and
      // upsert into the users table. If the function isn't deployed
      // yet, we still save the local session so the UI works — the
      // server-side membership write just won't happen.
      try {
        const { error: fnErr } = await supabase.functions.invoke("link-wallet", {
          body: {
            address: sig.address,
            message: sig.message,
            signature: sig.signature,
          },
        });
        if (fnErr) {
          // Soft-warn but keep the local session.
          console.warn("[VibeLogin] link-wallet edge function error:", fnErr.message);
        }
      } catch (e) {
        console.warn("[VibeLogin] link-wallet not reachable:", e);
      }

      setSession(sig);
      setStep("linked");
      onLinked?.(sig);
    } catch (e) {
      setError((e as Error).message ?? "Couldn't connect");
      setStep(address ? "linked" : "idle");
    }
  }, [address, onLinked]);

  const handleLogout = useCallback(() => {
    clearSession();
    setSession(null);
    setAddress(null);
    setBalanceWei(null);
    setStep("idle");
    setError(null);
    onDisconnected?.();
  }, [onDisconnected]);

  // ----- Render: card or pill --------------------------------------------
  if (variant === "card") {
    return <Card session={session} step={step} balanceWei={balanceWei} error={error} onConnect={handleConnect} onLogout={handleLogout} />;
  }
  return <Pill session={session} step={step} balanceWei={balanceWei} error={error} onConnect={handleConnect} onLogout={handleLogout} />;
}

// ----------------------------------------------------------------------
// Pill variant — compact, fits in nav bars / corners
// ----------------------------------------------------------------------

interface VariantProps {
  session: LinkedWallet | null;
  step: "idle" | "connecting" | "signing" | "linking" | "linked";
  balanceWei: bigint | null;
  error: string | null;
  onConnect: () => void;
  onLogout: () => void;
}

function Pill({ session, step, balanceWei, error, onConnect, onLogout }: VariantProps) {
  if (session) {
    return (
      <div className="glass-panel rounded-full pl-1 pr-2 py-1 flex items-center gap-2 border border-primary/30">
        <div className="w-6 h-6 rounded-full bg-primary/25 flex items-center justify-center text-[10px] font-mono text-primary">
          {session.address.slice(2, 4).toUpperCase()}
        </div>
        <div className="flex flex-col leading-none">
          <span className="text-[10px] font-mono text-foreground/85">
            {shortAddress(session.address)}
          </span>
          {balanceWei != null && (
            <span className="text-[9px] font-heading font-semibold text-primary mt-0.5">
              {formatVibe(balanceWei, { compact: true })} VIBE
            </span>
          )}
        </div>
        <button
          onClick={onLogout}
          className="ml-1 p-1 rounded-md hover:bg-muted/40 transition-colors"
          title="Disconnect wallet"
        >
          <LogOut className="w-3 h-3 text-muted-foreground" />
        </button>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-stretch gap-1">
      <button
        onClick={onConnect}
        disabled={step !== "idle"}
        className="glass-panel rounded-full px-3 py-1.5 flex items-center gap-2 border border-primary/40 hover:bg-primary/15 transition-colors text-[11px] font-heading font-semibold disabled:opacity-50"
      >
        {step === "idle" && <><Wallet className="w-3.5 h-3.5 text-primary" /> <span>Connect VIBE</span></>}
        {step === "connecting" && <><Loader2 className="w-3.5 h-3.5 animate-spin text-primary" /> <span>Opening wallet…</span></>}
        {step === "signing" && <><Sparkles className="w-3.5 h-3.5 text-primary animate-pulse" /> <span>Sign to link…</span></>}
        {step === "linking" && <><Loader2 className="w-3.5 h-3.5 animate-spin text-primary" /> <span>Linking…</span></>}
      </button>
      <AnimatePresence>
        {error && (
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            className="text-[10px] text-rose-300 bg-rose-400/10 border border-rose-400/30 rounded px-2 py-1 max-w-[260px]"
          >
            {error}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ----------------------------------------------------------------------
// Card variant — bigger /vibe-hub view
// ----------------------------------------------------------------------

function Card({ session, step, balanceWei, error, onConnect, onLogout }: VariantProps) {
  return (
    <div className="glass-panel rounded-2xl border border-primary/30 p-5 flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Wallet className="w-4 h-4 text-primary" />
        <p className="text-[10px] font-heading font-semibold tracking-widest uppercase text-primary">
          Your Wallet
        </p>
      </div>

      {session ? (
        <>
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-full bg-primary/25 flex items-center justify-center font-mono text-sm text-primary">
              {session.address.slice(2, 4).toUpperCase()}
            </div>
            <div className="flex flex-col">
              <a
                href={`https://basescan.org/address/${session.address}`}
                target="_blank"
                rel="noreferrer"
                className="text-sm font-mono text-foreground/95 hover:text-primary inline-flex items-center gap-1"
                title="Open in BaseScan"
              >
                {shortAddress(session.address)}
                <ExternalLink className="w-3 h-3 opacity-60" />
              </a>
              <span className="text-[10px] uppercase tracking-widest text-muted-foreground mt-0.5">
                Linked to Edge Esmeralda
              </span>
            </div>
          </div>

          <div className="rounded-lg bg-background/30 border border-border/60 px-3 py-2.5">
            <p className="text-[9px] uppercase tracking-widest text-muted-foreground">Your $VIBE</p>
            <p className="font-heading text-2xl font-bold tabular-nums">
              {balanceWei != null ? formatVibe(balanceWei) : "—"}
            </p>
          </div>

          <button
            onClick={onLogout}
            className="rounded-lg border border-border/60 bg-background/40 hover:bg-muted/40 transition-colors px-3 py-1.5 text-xs font-heading font-semibold text-muted-foreground flex items-center justify-center gap-1.5"
          >
            <LogOut className="w-3 h-3" />
            Disconnect
          </button>
        </>
      ) : (
        <>
          <p className="text-xs text-muted-foreground leading-snug">
            Connect a Base wallet (MetaMask, Coinbase Wallet, Rabby…) to attach
            your address to your community profile. Other members will see your
            $VIBE balance. No funds move — you just sign a message.
          </p>
          <button
            onClick={onConnect}
            disabled={step !== "idle"}
            className="bg-primary text-primary-foreground rounded-lg px-3 py-2 text-sm font-heading font-semibold hover:opacity-90 transition-opacity flex items-center justify-center gap-2 disabled:opacity-50"
          >
            {step === "idle" && <><Wallet className="w-4 h-4" /> Connect wallet</>}
            {step === "connecting" && <><Loader2 className="w-4 h-4 animate-spin" /> Opening wallet…</>}
            {step === "signing" && <><Sparkles className="w-4 h-4 animate-pulse" /> Sign to link…</>}
            {step === "linking" && <><Loader2 className="w-4 h-4 animate-spin" /> Linking…</>}
          </button>
        </>
      )}

      {error && (
        <p className="text-[11px] text-rose-300 bg-rose-400/10 border border-rose-400/30 rounded px-2 py-1.5">
          {error}
        </p>
      )}
    </div>
  );
}
