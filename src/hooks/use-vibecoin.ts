/**
 * useVibecoin — read the one balance, from anywhere.
 *
 *     const { balance, display, ledger, refresh } = useVibecoin();
 *
 * Every consumer shares a single fetch, a single realtime channel and a single
 * cached number. Five components can call this on the same page and the ledger
 * is queried once; the sixth mounts and gets the balance immediately from the
 * store rather than flashing a dash while its own request flies.
 *
 * The connection is reference-counted: it opens on the first mount and closes
 * on the last unmount, so a player who never opens anything that shows coins
 * never opens a websocket for them either.
 */
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  currentOwner,
  formatVibecoin,
  getVibecoinState,
  refreshVibecoin,
  subscribeVibecoin,
  type VibecoinState,
} from "@/lib/vibecoin";

/**
 * How many live consumers there are, and the teardown for the shared plumbing.
 * Module scope rather than context because worlds mount their UI in a dozen
 * places, several of them outside the React tree that owns the nav, and a
 * provider they all had to sit under does not exist.
 */
let mounted = 0;
let teardown: (() => void) | null = null;

function start(): void {
  mounted += 1;
  if (mounted > 1) return;

  void refreshVibecoin();

  /* A player earns coins in Vibe City in one tab and looks at the arcade in
     another. Postgres tells us; we do not poll. */
  let channel: ReturnType<typeof supabase.channel> | null = null;

  const bind = () => {
    void currentOwner().then((owner) => {
      // The last unmount may have already happened while this promise was in
      // flight, in which case there is nobody left to tell.
      if (mounted === 0) return;
      if (channel) {
        void supabase.removeChannel(channel);
        channel = null;
      }
      channel = supabase
        .channel(`vibecoin:${owner.ref}`)
        .on(
          "postgres_changes",
          {
            event: "*",
            schema: "public",
            table: "vibe_balances",
            filter: `owner_ref=eq.${owner.ref}`,
          },
          () => void refreshVibecoin(),
        )
        .subscribe();
    });
  };

  bind();

  /* Signing in swaps the wallet under our feet: the guest ref stops being the
     one that matters and the account ref starts. Waiting for the next focus or
     the next payout to notice meant a player who had just logged in watched
     their old number for a minute. Refetch on the spot, and re-point the
     realtime channel at the new owner. */
  const { data: authSub } = supabase.auth.onAuthStateChange((event) => {
    if (event === "INITIAL_SESSION") return;
    void refreshVibecoin();
    bind();
  });

  /* Coming back to the tab is the other moment the number is likely wrong —
     realtime drops silently on a sleeping laptop. */
  const onFocus = () => void refreshVibecoin();
  window.addEventListener("focus", onFocus);

  teardown = () => {
    window.removeEventListener("focus", onFocus);
    authSub.subscription.unsubscribe();
    if (channel) void supabase.removeChannel(channel);
  };
}


export interface UseVibecoin extends VibecoinState {
  /** Balance formatted for a chip — compact above 10K, `—` before first load. */
  display: string;
  refresh: () => Promise<number | null>;
}

export function useVibecoin(): UseVibecoin {
  const [s, setS] = useState<VibecoinState>(getVibecoinState);

  useEffect(() => {
    const off = subscribeVibecoin(setS);
    start();
    // Whatever landed between this component's initial state and its
    // subscription (another consumer's fetch resolving, say).
    setS(getVibecoinState());
    return () => {
      off();
      stop();
    };
  }, []);

  const refresh = useCallback(() => refreshVibecoin(), []);

  return {
    ...s,
    display: s.balance == null ? "—" : formatVibecoin(s.balance),
    refresh,
  };
}
