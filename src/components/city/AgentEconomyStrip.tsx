/**
 * AgentEconomyStrip — the in-chat shop/wallet panel that appears at the top
 * of PersonChatPanel when the chat target is an AI agent.
 *
 * Surfaces the agent's *purpose*, their live needs meter (energy/hunger/mood
 * — they decay over time and the agent can fall asleep), your wallet
 * balance, and four ways to spend $VIBE with them:
 *   • Services  – one-tap paid replies in chat
 *   • Tip       – send any amount
 *   • Items     – cosmetic unlocks bought from the agent
 *   • Bounties  – open quests posted by the agent that pay out on claim
 *
 * All money moves through the `vibe-economy` edge function (simulated
 * off-chain ledger today, swappable for real on-chain $VIBE later).
 */
import { useEffect, useMemo, useState } from "react";
import { Coins, Moon, Zap, Heart, Utensils, Gift, ShoppingBag, Sparkles, Target } from "lucide-react";
import { VibeEconomy, type AgentShop, type OwnerKind } from "@/lib/vibeEconomy";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

type Tab = "services" | "items" | "bounties" | "tip";

interface Props {
  agentId: string;
  ownerKind: OwnerKind;
  ownerRef: string;
  /** Called after a transaction so the parent chat can refresh history. */
  onTxn?: () => void;
}

export default function AgentEconomyStrip({ agentId, ownerKind, ownerRef, onTxn }: Props) {
  const [shop, setShop] = useState<AgentShop | null>(null);
  const [balance, setBalance] = useState<number | null>(null);
  const [tab, setTab] = useState<Tab>("services");
  const [busy, setBusy] = useState(false);
  const [tipAmount, setTipAmount] = useState("3");

  const refresh = async () => {
    try {
      const [s, w] = await Promise.all([
        VibeEconomy.agentShop(agentId),
        VibeEconomy.wallet(ownerKind, ownerRef),
      ]);
      setShop(s);
      setBalance(w.balance);
    } catch (e) {
      console.warn("[economy] refresh failed", e);
    }
  };

  useEffect(() => { void refresh(); /* eslint-disable-next-line */ }, [agentId, ownerRef]);

  // Live-update balance when ledger changes touch us.
  useEffect(() => {
    const ch = supabase.channel(`bal_${ownerRef}`)
      .on("postgres_changes",
        { event: "UPDATE", schema: "public", table: "vibe_balances", filter: `owner_ref=eq.${ownerRef}` },
        (p) => setBalance(Number((p.new as { balance: number }).balance)))
      .subscribe();
    return () => { void supabase.removeChannel(ch); };
  }, [ownerRef]);

  const asleep = shop?.economy.asleep ?? false;

  const handle = async (fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    try { await fn(); await refresh(); onTxn?.(); }
    catch (e) { toast.error((e as Error).message); }
    finally { setBusy(false); }
  };

  const buyService = (sid: string, title: string, price: number) =>
    handle(async () => {
      await VibeEconomy.buyService(ownerKind, ownerRef, agentId, sid);
      toast.success(`Paid ${price} VIBE for "${title}"`);
      // Drop a system-style nudge into chat so the agent's reply has context.
      await supabase.from("island_dms").insert({
        thread_key: [`user:${ownerRef}`, `agent:${agentId}`].sort().join("|"),
        from_kind: "user", from_ref: ownerRef, from_name: "you",
        to_kind: "agent", to_ref: agentId,
        body: `[paid ${price} VIBE for "${title}"] please deliver`,
      });
    });

  const buyItem = (iid: string, title: string, price: number) =>
    handle(async () => {
      await VibeEconomy.buyItem(ownerKind, ownerRef, agentId, iid);
      toast.success(`Bought "${title}" for ${price} VIBE — added to inventory.`);
    });

  const tip = () =>
    handle(async () => {
      const amt = Number(tipAmount);
      if (!Number.isFinite(amt) || amt <= 0) throw new Error("Enter a positive amount");
      await VibeEconomy.tip(ownerKind, ownerRef, agentId, amt, "tip");
      await supabase.from("island_dms").insert({
        thread_key: [`user:${ownerRef}`, `agent:${agentId}`].sort().join("|"),
        from_kind: "user", from_ref: ownerRef, from_name: "you",
        to_kind: "agent", to_ref: agentId,
        body: `[tipped ${amt} VIBE 💸]`,
      });
      toast.success(`Tipped ${amt} VIBE`);
    });

  const claimBounty = (bid: string, title: string) =>
    handle(async () => {
      await VibeEconomy.claimBounty(ownerKind, ownerRef, bid);
      toast.success(`Claimed "${title}" — bring proof and the agent will pay out.`);
    });

  const needsBar = (label: string, value: number, icon: React.ReactNode) => (
    <div className="flex items-center gap-1.5">
      <span className="text-muted-foreground">{icon}</span>
      <div className="h-1.5 w-10 rounded-full bg-muted overflow-hidden">
        <div className="h-full bg-primary" style={{ width: `${Math.round(value * 100)}%` }} />
      </div>
    </div>
  );

  return (
    <div className="border-b border-border/60 bg-muted/30 px-3 py-2 text-xs flex flex-col gap-2">
      {/* purpose + needs + wallet row */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="flex items-center gap-1 rounded-full bg-background px-2 py-0.5 font-medium">
          <Coins className="h-3 w-3 text-primary" />
          {balance ?? "…"} VIBE
        </span>
        {shop && (
          <>
            <span className="text-muted-foreground italic truncate flex-1 min-w-0">
              "{shop.economy.purpose}"
            </span>
            <div className="flex items-center gap-2">
              {needsBar("energy", shop.economy.needs.energy, <Zap className="h-3 w-3" />)}
              {needsBar("hunger", shop.economy.needs.hunger, <Utensils className="h-3 w-3" />)}
              {needsBar("mood",   shop.economy.needs.mood,   <Heart className="h-3 w-3" />)}
            </div>
          </>
        )}
      </div>

      {asleep && (
        <div className="flex items-center gap-1.5 text-[11px] text-amber-400">
          <Moon className="h-3 w-3" />
          {shop?.agent.name} is asleep — replies pause until they wake up.
          A small tip might help.
        </div>
      )}

      {/* tabs */}
      <div className="flex gap-1">
        {([
          ["services", <Sparkles key="s" className="h-3 w-3" />, "Services"],
          ["tip",      <Gift     key="g" className="h-3 w-3" />, "Tip"],
          ["items",    <ShoppingBag key="i" className="h-3 w-3" />, "Shop"],
          ["bounties", <Target   key="b" className="h-3 w-3" />, "Bounties"],
        ] as const).map(([k, icon, label]) => (
          <button
            key={k}
            onClick={() => setTab(k as Tab)}
            className={`flex items-center gap-1 px-2 py-1 rounded-full text-[11px] transition ${
              tab === k ? "bg-primary text-primary-foreground" : "bg-background hover:bg-background/70"
            }`}
          >
            {icon}{label}
          </button>
        ))}
      </div>

      {/* tab body */}
      {shop && tab === "services" && (
        <div className="flex flex-col gap-1">
          {shop.economy.services.map((s) => (
            <button
              key={s.id}
              disabled={busy || asleep}
              onClick={() => buyService(s.id, s.title, s.price)}
              className="flex items-center justify-between gap-2 rounded-md bg-background px-2 py-1.5 text-left hover:bg-background/70 disabled:opacity-50"
            >
              <span className="flex flex-col">
                <span className="font-medium">{s.title}</span>
                <span className="text-[10px] text-muted-foreground">{s.desc}</span>
              </span>
              <span className="font-mono text-primary whitespace-nowrap">{s.price} VIBE</span>
            </button>
          ))}
        </div>
      )}

      {shop && tab === "items" && (
        <div className="flex flex-col gap-1">
          {shop.economy.items.map((s) => (
            <button
              key={s.id}
              disabled={busy || asleep}
              onClick={() => buyItem(s.id, s.title, s.price)}
              className="flex items-center justify-between gap-2 rounded-md bg-background px-2 py-1.5 text-left hover:bg-background/70 disabled:opacity-50"
            >
              <span className="flex flex-col">
                <span className="font-medium">{s.title}</span>
                <span className="text-[10px] text-muted-foreground">{s.desc}</span>
              </span>
              <span className="font-mono text-primary whitespace-nowrap">{s.price} VIBE</span>
            </button>
          ))}
        </div>
      )}

      {tab === "tip" && (
        <div className="flex items-center gap-1.5">
          <Input
            value={tipAmount}
            onChange={(e) => setTipAmount(e.target.value.replace(/[^0-9.]/g, ""))}
            className="h-7 w-20 text-xs"
            inputMode="decimal"
          />
          <span className="text-muted-foreground">VIBE</span>
          <Button size="sm" className="h-7 ml-auto" disabled={busy} onClick={tip}>
            Send tip
          </Button>
        </div>
      )}

      {shop && tab === "bounties" && (
        <div className="flex flex-col gap-1">
          {shop.bounties.length === 0 && (
            <div className="text-[11px] text-muted-foreground italic">
              No bounties posted right now. Check back when {shop.agent.name} gets hungry.
            </div>
          )}
          {shop.bounties.map((b) => (
            <div
              key={b.id}
              className="flex items-center justify-between gap-2 rounded-md bg-background px-2 py-1.5"
            >
              <span className="flex flex-col min-w-0">
                <span className="font-medium truncate">{b.title}</span>
                {b.description && (
                  <span className="text-[10px] text-muted-foreground truncate">{b.description}</span>
                )}
              </span>
              <span className="font-mono text-primary whitespace-nowrap">+{b.reward}</span>
              {b.status === "open" ? (
                <Button size="sm" className="h-6 text-[10px]" disabled={busy}
                  onClick={() => claimBounty(b.id, b.title)}>claim</Button>
              ) : (
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{b.status}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
