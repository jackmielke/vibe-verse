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
 *
 * Editing: the text in the file is the default. Jack's rewrites, notes and
 * favorites live in `horizon_stations` (one row per station, readable by all,
 * writable by admins via `is_admin()`). The frame says `horizon:ready`; this
 * page answers with the saved edits and whether the viewer is an admin, and
 * writes whatever `horizon:save` sends back. The frame never touches Supabase.
 */
import { useEffect, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useWorldStamp } from "@/hooks/use-world-stamp";

type Row = { key: string; fields: Record<string, unknown> };
// Not in the generated types yet; keep the cast in one place.
const stations = () => (supabase as unknown as { from: (t: string) => any }).from("horizon_stations");

export default function Horizon() {
  useWorldStamp("/horizon", "Horizon Garden");
  const frame = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    const post = (msg: unknown) => frame.current?.contentWindow?.postMessage(msg, window.location.origin);

    const init = async () => {
      const [{ data: rows }, { data: admin }] = await Promise.all([
        stations().select("key, fields") as Promise<{ data: Row[] | null }>,
        supabase.rpc("is_admin").then((r) => r, () => ({ data: false })),
      ]);
      const overrides: Record<string, unknown> = {};
      (rows ?? []).forEach((r) => { overrides[r.key] = r.fields; });
      post({ type: "horizon:init", overrides, canEdit: admin === true });
    };

    const onMessage = async (e: MessageEvent) => {
      if (e.origin !== window.location.origin || e.source !== frame.current?.contentWindow) return;
      const d = e.data as { type?: string; key?: string; fields?: Record<string, unknown> };
      if (d?.type === "horizon:ready") init();
      if (d?.type === "horizon:save" && typeof d.key === "string") {
        const { error } = await stations().upsert({ key: d.key, fields: d.fields ?? {}, updated_at: new Date().toISOString() });
        post({ type: "horizon:saved", key: d.key, ok: !error, error: error?.message });
      }
    };

    window.addEventListener("message", onMessage);
    const { data: sub } = supabase.auth.onAuthStateChange(() => init());
    return () => { window.removeEventListener("message", onMessage); sub.subscription.unsubscribe(); };
  }, []);

  return (
    <iframe
      ref={frame}
      title="Horizon Garden"
      src="/worlds/horizon/index.html"
      className="fixed inset-0 h-full w-full border-0"
      style={{ background: "#f6d6c6" }}
    />
  );
}
