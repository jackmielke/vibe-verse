/**
 * Stamp the passport when a world is entered.
 *
 * One line per world:
 *
 *     useWorldStamp("/seafair", "Seafair 2117");
 *
 * That is the whole contract. It runs once on mount, writes to localStorage,
 * and cannot throw — see `stampPassport`. A world that adopts it gains nothing
 * for itself; what it gains is that *every other world* can now tell you have
 * been there. The ship's archive terminal is the first thing that reads them.
 */
import { useEffect } from "react";
import { stampPassport } from "@/lib/passport";

export function useWorldStamp(route: string, name: string): void {
  useEffect(() => {
    stampPassport(route, name);
    // Route and name are constants at every call site; listing them keeps the
    // exhaustive-deps rule happy without ever actually re-running.
  }, [route, name]);
}
