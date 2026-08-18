/**
 * /newsroom — the floor The Vibe Times is put together on.
 *
 * Thin on purpose: the room lives in `src/newsroom/`. This page exists to
 * stamp the passport and mount it.
 */
import { useWorldStamp } from "@/hooks/use-world-stamp";
import { PressRoom } from "@/newsroom/PressRoom";

export default function Newsroom() {
  useWorldStamp("/newsroom", "The Newsroom");
  return <PressRoom />;
}
