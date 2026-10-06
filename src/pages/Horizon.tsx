/**
 * `/horizon` — Horizon Garden, an opportunity map of the future you can walk.
 *
 * Twenty-three monuments on a dawn island, one per frontier (the 24/7 teammate,
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
 *
 * Signals: `horizon_signals` holds dated evidence per station (the daily digest
 * files them; Jack edits, hides or adds them in Edit mode). They ride along in
 * `horizon:init`; `horizon:signal` upserts one and `horizon:signal-delete` removes it.
 * If the table is missing the garden simply has no signals.
 *
 * Signing in: /horizon is chromeless and horizon.jackmielke.com frames it as a
 * third-party iframe, where the browser partitions storage and the Vibe Verse
 * session never arrives. So the frame has its own quiet pencil
 * (`horizon:signin`) that opens the code-first sign-in dialog right here. An
 * email code needs no redirect, so it works inside somebody else's page, and
 * the session it mints lives in that partition from then on.
 */
import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useWorldStamp } from "@/hooks/use-world-stamp";
import VibeAuthDialog from "@/components/vibe-auth/VibeAuthDialog";

type Row = { key: string; fields: Record<string, unknown> };
// Not in the generated types yet; keep the cast in one place.
const table = (t: string) => (supabase as unknown as { from: (t: string) => any }).from(t);
const stations = () => table("horizon_stations");
const signals = () => table("horizon_signals");
const SIGNAL_FIELDS = "id, station_key, day, headline, why, era, direction, url, source, hidden";

export default function Horizon() {
  useWorldStamp("/horizon", "Horizon Garden");
  const frame = useRef<HTMLIFrameElement>(null);
  const [signingIn, setSigningIn] = useState(false);
  // horizon.jackmielke.com frames this page with ?embed=1: no Vibe Verse chrome, inside or out
  const standalone = new URLSearchParams(window.location.search).get("embed") === "1";

  useEffect(() => {
    const post = (msg: unknown) => frame.current?.contentWindow?.postMessage(msg, window.location.origin);

    const init = async () => {
      const [{ data: rows }, { data: sigs }, { data: admin }] = await Promise.all([
        stations().select("key, fields") as Promise<{ data: Row[] | null }>,
        signals().select(SIGNAL_FIELDS).order("day", { ascending: false }).then((r: { data: unknown[] | null }) => r, () => ({ data: [] })),
        supabase.rpc("is_admin").then((r) => r, () => ({ data: false })),
      ]);
      const overrides: Record<string, unknown> = {};
      (rows ?? []).forEach((r) => { overrides[r.key] = r.fields; });
      post({ type: "horizon:init", overrides, signals: sigs ?? [], canEdit: admin === true });
    };

    const onMessage = async (e: MessageEvent) => {
      if (e.origin !== window.location.origin || e.source !== frame.current?.contentWindow) return;
      const d = e.data as { type?: string; key?: string; id?: string; fields?: Record<string, unknown>; signal?: Record<string, unknown> };
      if (d?.type === "horizon:ready") init();
      if (d?.type === "horizon:signin") {
        // Signed in already, but not as an editor: say so and offer the other door.
        const { data: { session } } = await supabase.auth.getSession();
        if (session) {
          post({ type: "horizon:toast", text: `${session.user.email ?? "This account"} can't edit. Sign in as Jack.` });
          await supabase.auth.signOut();
        }
        setSigningIn(true);
      }
      if (d?.type === "horizon:save" && typeof d.key === "string") {
        const { error } = await stations().upsert({ key: d.key, fields: d.fields ?? {}, updated_at: new Date().toISOString() });
        post({ type: "horizon:saved", key: d.key, ok: !error, error: error?.message });
      }
      if (d?.type === "horizon:signal" && d.signal) {
        const { data, error } = await signals().upsert({ ...d.signal, updated_at: new Date().toISOString() }).select(SIGNAL_FIELDS).single();
        post({ type: "horizon:signal-saved", ok: !error, error: error?.message, signal: data, tempId: d.id });
      }
      if (d?.type === "horizon:signal-delete" && typeof d.id === "string") {
        const { error } = await signals().delete().eq("id", d.id);
        post({ type: "horizon:saved", ok: !error, error: error?.message });
      }
    };

    window.addEventListener("message", onMessage);
    const { data: sub } = supabase.auth.onAuthStateChange(() => init());
    return () => { window.removeEventListener("message", onMessage); sub.subscription.unsubscribe(); };
  }, []);

  return (
    <>
    <iframe
      ref={frame}
      title="Horizon Garden"
      src={`/worlds/horizon/index.html${standalone ? "?standalone=1" : ""}`}
      className="fixed inset-0 h-full w-full border-0"
      style={{ background: "#f6d6c6" }}
    />
    <VibeAuthDialog open={signingIn} onOpenChange={setSigningIn} />
    </>
  );
}
