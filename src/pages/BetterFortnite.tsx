/**
 * BETTER FORTNITE — the third game on the island.
 *
 * Same canvas, same boot, same HUD as `/drop-zero`; the page reads the route
 * and boots `mode: "better"`, which adds four systems the other two games
 * never load: augments, the grapple, second wind and island events. See
 * `src/royale/mode/better.ts` for what each one is and every number in it.
 *
 * A page of its own so it stamps its own passport entry. It is a second
 * world, not a variant of one.
 */
import { RoyalePage } from "./DropZero";
import { useWorldStamp } from "@/hooks/use-world-stamp";

export default function BetterFortnite() {
  useWorldStamp("/better-fortnite", "Better Fortnite");
  return <RoyalePage />;
}
