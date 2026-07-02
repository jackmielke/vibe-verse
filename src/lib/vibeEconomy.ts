/**
 * vibeEconomy — thin browser client for the `vibe-economy` edge function.
 *
 * Wraps the simulated $VIBE ledger so the UI can stay agnostic about whether
 * we're using the off-chain ledger today or real on-chain $VIBE later — same
 * shapes, same actions, just a different backend swap behind this module.
 */
import { supabase } from "@/integrations/supabase/client";

export type OwnerKind = "user" | "agent";

export interface LedgerRow {
  id: string;
  from_kind: string | null; from_ref: string | null;
  to_kind: string | null;   to_ref: string | null;
  amount: number; reason: string; memo: string | null;
  created_at: string;
}
export interface AgentShop {
  agent: { id: string; name: string; prompt: string | null };
  economy: {
    agent_id: string;
    purpose: string;
    services: Array<{ id: string; title: string; desc: string; price: number }>;
    items: Array<{ id: string; title: string; desc: string; price: number; cosmetic_key?: string }>;
    needs: { energy: number; hunger: number; mood: number };
    asleep: boolean;
    asleep_until: string | null;
  };
  balance: number;
  bounties: Array<{
    id: string; agent_id: string; title: string; description: string | null;
    reward: number; status: "open"|"claimed"|"paid"|"cancelled";
    claimed_by_kind: string | null; claimed_by_ref: string | null;
  }>;
}

async function call<T>(action: string, payload: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke("vibe-economy", {
    body: { action, ...payload },
  });
  if (error) throw new Error(error.message);
  if (!data?.ok) throw new Error(data?.error ?? "vibe-economy error");
  return data.data as T;
}

export const VibeEconomy = {
  wallet: (ownerKind: OwnerKind, ownerRef: string) =>
    call<{ balance: number; ledger: LedgerRow[] }>("wallet", { ownerKind, ownerRef }),
  agentShop: (agentId: string) =>
    call<AgentShop>("agent_shop", { agentId }),
  tip: (fromKind: OwnerKind, fromRef: string, agentId: string, amount: number, memo?: string) =>
    call<{ fromBalance: number; toBalance: number }>("tip", { fromKind, fromRef, agentId, amount, memo }),
  buyService: (fromKind: OwnerKind, fromRef: string, agentId: string, serviceId: string) =>
    call<{ fromBalance: number; service: { title: string } }>("buy_service", { fromKind, fromRef, agentId, serviceId }),
  buyItem: (fromKind: OwnerKind, fromRef: string, agentId: string, itemId: string) =>
    call<{ fromBalance: number; item: { title: string } }>("buy_item", { fromKind, fromRef, agentId, itemId }),
  claimBounty: (fromKind: OwnerKind, fromRef: string, bountyId: string) =>
    call("claim_bounty", { fromKind, fromRef, bountyId }),
  /** Mint $VIBE for a sky-island mini-game run. The server clamps the
   * score, caps the payout, and limits rewarded runs per game per day. */
  gameReward: (ownerKind: OwnerKind, ownerRef: string, game: string, score: number) =>
    call<{ amount: number; balance: number; capped: boolean; playsLeft: number | null }>(
      "game_reward",
      { ownerKind, ownerRef, game, score },
    ),
};
