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
 *
 * Social: `horizon_visits` (one row per visitor, station and day) and
 * `horizon_comments` (notes left at a monument) ride along as `horizon:social`.
 * The frame sends `horizon:visit` and `horizon:comment`; this page writes them.
 * Everybody walking right now shares one Realtime channel: the frame posts its
 * position (`horizon:pos`) a few times a second, this page broadcasts it and
 * relays everybody else's as `horizon:peer` / `horizon:peer-gone`. Positions
 * are never stored. The visitor id and name live in this origin's storage.
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
const visits = () => table("horizon_visits");
const comments = () => table("horizon_comments");
const COMMENT_FIELDS = "id, station_key, visitor, name, body, hidden, created_at";

function visitorId(): string {
  try {
    let v = localStorage.getItem("horizon.visitor");
    if (!v) { v = `v-${crypto.randomUUID()}`; localStorage.setItem("horizon.visitor", v); }
    return v;
  } catch { return `v-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`; }
}
const storedName = () => { try { return localStorage.getItem("horizon.name") ?? ""; } catch { return ""; } };

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
      post({ type: "horizon:init", overrides, signals: sigs ?? [], canEdit: admin === true, me: { visitor: me, name: storedName() } });
      social();
    };

    // Who has been where, and the notes people left. Missing tables just mean an empty garden.
    const me = visitorId();
    const social = async () => {
      type Res = { data: unknown[] | null; error?: unknown };
      const failed: Res = { data: null, error: true };
      const [rv, rc] = await Promise.all([
        visits().select("visitor, station_key, name, day").order("day", { ascending: false }).limit(5000).then((r: Res) => r, () => failed),
        comments().select(COMMENT_FIELDS).order("created_at", { ascending: false }).limit(800).then((r: Res) => r, () => failed),
      ]);
      post({ type: "horizon:social", available: !rv.error && !rc.error, visits: rv.data ?? [], comments: rc.data ?? [] });
    };

    // Live walkers: one broadcast channel, presence for who is here.
    const peers = new Map<string, number>();
    const channel = supabase.channel("horizon-garden", { config: { broadcast: { self: false }, presence: { key: me } } });
    channel
      .on("broadcast", { event: "pos" }, ({ payload }: { payload: Record<string, unknown> }) => {
        if (!payload || payload.id === me) return;
        peers.set(String(payload.id), Date.now());
        post({ type: "horizon:peer", ...payload });
      })
      .on("presence", { event: "leave" }, ({ key }: { key: string }) => { peers.delete(key); post({ type: "horizon:peer-gone", id: key }); })
      .subscribe((status: string) => { if (status === "SUBSCRIBED") channel.track({ name: storedName() }).catch(() => {}); });
    const sweep = window.setInterval(() => {
      const now = Date.now();
      peers.forEach((t, id) => { if (now - t > 8000) { peers.delete(id); post({ type: "horizon:peer-gone", id }); } });
    }, 3000);

    const onMessage = async (e: MessageEvent) => {
      if (e.origin !== window.location.origin || e.source !== frame.current?.contentWindow) return;
      const d = e.data as { type?: string; key?: string; id?: string; fields?: Record<string, unknown>; signal?: Record<string, unknown> };
      if (d?.type === "horizon:ready") init();
      const m = e.data as { type?: string; key?: string; name?: string; body?: string; x?: number; z?: number; r?: number; y?: number; c?: number };
      if (m?.type === "horizon:name" && typeof m.name === "string") {
        try { localStorage.setItem("horizon.name", m.name.slice(0, 40)); } catch { /* private window */ }
        channel.track({ name: m.name.slice(0, 40) }).catch(() => {});
      }
      if (m?.type === "horizon:pos") {
        channel.send({ type: "broadcast", event: "pos", payload: { id: me, name: storedName(), x: m.x, z: m.z, r: m.r, y: m.y, c: m.c } }).catch(() => {});
      }
      if (m?.type === "horizon:visit" && typeof m.key === "string") {
        await visits().upsert({ visitor: me, station_key: m.key, name: storedName() || null }, { onConflict: "visitor,station_key,day", ignoreDuplicates: true }).then(() => {}, () => {});
        social();
      }
      if (m?.type === "horizon:comment" && typeof m.key === "string" && typeof m.body === "string") {
        const name = (m.name || storedName() || "A visitor").slice(0, 40);
        try { localStorage.setItem("horizon.name", name); } catch { /* private window */ }
        const { error } = await comments().insert({ station_key: m.key, visitor: me, name, body: m.body.slice(0, 500) });
        post({ type: "horizon:comment-saved", ok: !error, error: error?.message });
        social();
      }
      if (m?.type === "horizon:comment-hide" && typeof (e.data as { id?: string }).id === "string") {
        const { error } = await comments().update({ hidden: true }).eq("id", (e.data as { id: string }).id);
        post({ type: "horizon:saved", ok: !error, error: error?.message });
        social();
      }
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
    return () => {
      window.removeEventListener("message", onMessage); sub.subscription.unsubscribe();
      window.clearInterval(sweep); supabase.removeChannel(channel);
    };
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
