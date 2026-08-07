/**
 * useWardrobe — what you own and what you are wearing, from anywhere.
 *
 * Same shape as `useVibecoin`, and for the same reasons: one shared fetch
 * across every consumer, a cached answer available on the first render so
 * nothing flashes a bare head, and a reference count so a page that never
 * shows cosmetics never asks the server about them.
 *
 * It also owns the one moment the whole currency depended on and nobody was
 * watching: **signing in**. The instant an auth session appears, the guest
 * wallet gets claimed — see `claimGuestWallet`.
 */
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  claimGuestWallet,
  getWardrobeState,
  refreshWardrobe,
  subscribeWardrobe,
  type WardrobeState,
} from "@/lib/wardrobe";
import { refreshVibecoin } from "@/lib/vibecoin";

let mounted = 0;
let teardown: (() => void) | null = null;

function start(): void {
  mounted += 1;
  if (mounted > 1) return;

  void refreshWardrobe();

  /* Sign-in is the merge point. `onAuthStateChange` fires for the restored
     session too, which is what we want — someone who signed in on a previous
     visit and never got merged (because this code did not exist yet) is caught
     the next time they open the app. */
  const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
    if (!session?.user) return;
    if (event !== "SIGNED_IN" && event !== "INITIAL_SESSION" && event !== "TOKEN_REFRESHED") return;
    void claimGuestWallet().then(() => {
      void refreshVibecoin();
      void refreshWardrobe();
    });
  });

  teardown = () => sub.subscription.unsubscribe();
}

function stop(): void {
  mounted = Math.max(0, mounted - 1);
  if (mounted === 0) {
    teardown?.();
    teardown = null;
  }
}

export interface UseWardrobe extends WardrobeState {
  refresh: () => Promise<WardrobeState>;
}

export function useWardrobe(): UseWardrobe {
  const [s, setS] = useState<WardrobeState>(getWardrobeState);

  useEffect(() => {
    const off = subscribeWardrobe(setS);
    start();
    setS(getWardrobeState());
    return () => {
      off();
      stop();
    };
  }, []);

  const refresh = useCallback(() => refreshWardrobe(), []);
  return { ...s, refresh };
}
