/**
 * Stamp the passport when a world is entered — and get paid for it.
 *
 * One line per world, unchanged:
 *
 *     useWorldStamp("/seafair", "Seafair 2117");
 *
 * That is still the whole contract. It runs once on mount, writes to
 * localStorage, and cannot throw. What changed is what happens after: the first
 * time you arrive anywhere, the stamp is reported to `vibe-explore` and the
 * ledger pays for it. Thirty worlds already call this hook, so thirty worlds
 * became worth coins without one of them being edited.
 *
 * The two halves are deliberately ordered and deliberately unequal. The local
 * stamp is synchronous and always happens; the payout is fired and forgotten.
 * A world is a canvas about to run at 60fps — it must not wait on a network
 * call, must not fail to boot because Supabase is slow, and must not care
 * whether the coins landed. `syncExplore` resolves either way and skips the
 * request entirely when there is nothing new to report, which is the common
 * case: somebody walking back into a world they have already collected.
 */
import { useEffect } from "react";

import { syncExplore } from "@/lib/explore";
import { stampPassport } from "@/lib/passport";

export function useWorldStamp(route: string, name: string): void {
  useEffect(() => {
    stampPassport(route, name);
    // Fire and forget. Nothing in the world above renders off the result — the
    // stamp moment listens on the celebration bus instead, so a world that
    // unmounts mid-flight simply stops being told, rather than setting state on
    // something that is gone.
    void syncExplore();
    // Route and name are constants at every call site; listing them keeps the
    // exhaustive-deps rule happy without ever actually re-running.
  }, [route, name]);
}
