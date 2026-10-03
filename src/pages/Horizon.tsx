/**
 * `/horizon` — Horizon Garden, an opportunity map of the future you can walk.
 *
 * Fifteen monuments on a dawn island, one per frontier (the 24/7 teammate,
 * robots, memory, private money, space, self-driving and the rest). Walk up to
 * one and it tells you where that frontier is now and where it goes in 5, 10
 * and 50 years. There is an Atlas view for reading it all on one page.
 *
 * The world is a single self-contained HTML file (three.js from a CDN) that
 * also lives on its own at horizon-garden-delta.vercel.app, so the canonical
 * copy is `public/worlds/horizon/index.html` and this page only frames it.
 * The frame is same-origin, so the file's own "← Vibe Verse" link can leave
 * with `target="_top"`.
 */
import { useWorldStamp } from "@/hooks/use-world-stamp";

export default function Horizon() {
  useWorldStamp("/horizon", "Horizon Garden");
  return (
    <iframe
      title="Horizon Garden"
      src="/worlds/horizon/index.html"
      className="fixed inset-0 h-full w-full border-0"
      style={{ background: "#f6d6c6" }}
    />
  );
}
