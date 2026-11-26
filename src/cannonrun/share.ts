/**
 * One tap from a Gatch News replay clip to a link anybody can open. The clip
 * lives in this browser (replay.ts) until Share is pressed; then the
 * gatch-clip edge function stores it in the public `gatch-clips` bucket and
 * hands back an id, and /gatch/<id> plays it (pages/GatchClip.tsx).
 */
import type { ReplayClip } from "./replay";

const BASE = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/gatch-clip`;
const KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string;
const auth = { apikey: KEY, Authorization: `Bearer ${KEY}` };

/** blob url → the link; the same clip is only ever uploaded once per page */
const done = new Map<string, string>();

export async function uploadClip(c: ReplayClip): Promise<string> {
  const had = done.get(c.url);
  if (had) return had;
  const blob = await (await fetch(c.url)).blob();
  const h = c.headlines[0] ?? { headline: "", sub: "" };
  const q = new URLSearchParams({ headline: h.headline, sub: h.sub });
  const res = await fetch(`${BASE}?${q}`, { method: "POST", headers: { ...auth, "Content-Type": blob.type || c.type }, body: blob });
  const out = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
  if (res.status === 404) throw new Error("sharing isn't switched on yet");
  if (!res.ok || !out.id) throw new Error(out.error ?? `upload failed (${res.status})`);
  const link = `${window.location.origin}/gatch/${out.id}`;
  done.set(c.url, link);
  return link;
}

/** Upload, then the share sheet where there is one, else the clipboard. Says which. */
export async function shareClip(c: ReplayClip): Promise<{ link: string; how: "shared" | "copied" | "shown" }> {
  const link = await uploadClip(c);
  const title = c.headlines[0]?.headline ?? "Gatch News";
  if (navigator.share) {
    try { await navigator.share({ title: `GATCH NEWS: ${title}`, text: "Breaking from Cannon Chase", url: link }); return { link, how: "shared" }; }
    catch (e) { if ((e as Error).name === "AbortError") return { link, how: "shown" }; }
  }
  try { await navigator.clipboard.writeText(link); return { link, how: "copied" }; } catch { return { link, how: "shown" }; }
}

export interface SharedClip { id: string; headline: string; sub: string; type: string; video: string }

export async function loadClip(id: string): Promise<SharedClip | null> {
  const res = await fetch(`${BASE}?id=${encodeURIComponent(id)}`, { headers: auth });
  if (!res.ok) return null;
  return (await res.json()) as SharedClip;
}
