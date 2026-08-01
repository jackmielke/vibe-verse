/**
 * Fetch the vibeverse's own records for the ship's archive terminal.
 *
 * This lives on the app side of the line, not in `src/longsilence`: the engine
 * is a vendored fork that has to stay re-syncable, so it never learns what
 * Supabase is. It is handed a plain object and knows how to draw it.
 *
 * Everything here is best-effort. The ship is a route — it can be opened
 * signed-out, offline, or from a network that cannot reach the database at all
 * — and a terminal that says "no traffic on the band" is fine where a terminal
 * that throws takes the whole world down with it. Every query is wrapped, and
 * a failure degrades that one panel rather than the fetch.
 */
import { supabase } from "@/integrations/supabase/client";

export interface VibePhoto {
  title: string;
  caption: string;
  residency: string;
  img: HTMLImageElement | null;
}
export interface VibeCrew { name: string; detail: string; resident: boolean }
export interface VibeAgent { name: string; status: string; color: string; seen: string }
export interface VibeMessage { speaker: string; body: string; kind: string; when: string }

export interface VibeversePayload {
  photos: VibePhoto[];
  crew: VibeCrew[];
  agents: VibeAgent[];
  messages: VibeMessage[];
  counts: Record<string, number>;
  error?: string;
}

/** Trim anything headed for a 1000-pixel-wide panel. */
function clip(s: unknown, n: number): string {
  const t = (s == null ? "" : String(s)).replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function ago(iso: string | null): string {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  const m = ms / 60000;
  if (m < 60) return `${Math.max(1, Math.round(m))}m`;
  const h = m / 60;
  if (h < 24) return `${Math.round(h)}h`;
  return `${Math.round(h / 24)}d`;
}

/**
 * Load one photograph for use as a canvas texture.
 *
 * `crossOrigin` is set BEFORE `src`, and that ordering is the whole safety
 * argument. The archive panel is a canvas that becomes a WebGL texture every
 * few frames; drawing a cross-origin image onto it without CORS would *taint*
 * it, and the next texture upload would throw — taking out not just the
 * gallery but every display in the ship, since they share the same path.
 *
 * With `crossOrigin` set, a server that does not send the header fails the
 * image *load* instead. So the bad case is a photograph that never appears,
 * which the panel already draws a caption card for. It cannot be the case that
 * the ship's instruments go dark because a bucket changed its policy.
 */
function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    if (!url) return resolve(null);
    const img = new Image();
    img.crossOrigin = "anonymous";
    let settled = false;
    const done = (v: HTMLImageElement | null) => { if (!settled) { settled = true; resolve(v); } };
    img.onload = () => done(img);
    img.onerror = () => done(null);
    // A stalled CDN must not hold the boot sequence open forever.
    setTimeout(() => done(null), 12000);
    img.src = url;
  });
}

export async function loadVibeverse(): Promise<VibeversePayload> {
  const out: VibeversePayload = { photos: [], crew: [], agents: [], messages: [], counts: {} };

  /* One failing table must not cost the others, so the four queries are
     settled independently rather than awaited as a block. */
  const [photoRes, userRes, agentRes, msgRes] = await Promise.allSettled([
    supabase.from("gallery_photos")
      .select("title, description, residency_name, image_url, display_order, is_visible")
      .not("image_url", "is", null)
      .neq("is_visible", false)
      .order("display_order", { ascending: true, nullsFirst: false })
      .limit(14),
    supabase.from("users")
      .select("name, username, headline, is_vibe_resident")
      .not("name", "is", null)
      .limit(24),
    supabase.from("world_agents")
      .select("name, status, color, last_seen_at")
      .order("last_seen_at", { ascending: false, nullsFirst: false })
      .limit(24),
    supabase.from("world_messages")
      .select("speaker, body, kind, created_at")
      .order("created_at", { ascending: false })
      .limit(40),
  ]);

  const rows = <T,>(r: PromiseSettledResult<{ data: T[] | null }>): T[] =>
    r.status === "fulfilled" && Array.isArray(r.value?.data) ? r.value.data : [];

  type PhotoRow = { title: string | null; description: string | null; residency_name: string | null; image_url: string };
  const photoRows = rows<PhotoRow>(photoRes as PromiseSettledResult<{ data: PhotoRow[] | null }>);

  /* Images are fetched in parallel with each other but awaited as a group, and
     a failure resolves to null rather than rejecting — see loadImage. */
  const imgs = await Promise.all(photoRows.map((p) => loadImage(p.image_url)));
  out.photos = photoRows.map((p, i) => ({
    title: clip(p.title || p.residency_name || "UNTITLED", 42),
    caption: clip(p.description, 120),
    residency: clip(p.residency_name, 28),
    img: imgs[i],
  }));

  type UserRow = { name: string | null; username: string | null; headline: string | null; is_vibe_resident: boolean | null };
  out.crew = rows<UserRow>(userRes as PromiseSettledResult<{ data: UserRow[] | null }>)
    .map((u) => ({
      name: clip(u.name, 26),
      detail: clip(u.headline || (u.username ? `@${u.username}` : ""), 34),
      resident: !!u.is_vibe_resident,
    }))
    .filter((u) => u.name);

  type AgentRow = { name: string | null; status: string | null; color: string | null; last_seen_at: string | null };
  out.agents = rows<AgentRow>(agentRes as PromiseSettledResult<{ data: AgentRow[] | null }>)
    .map((a) => ({
      name: clip(a.name, 24),
      status: clip(a.status || "idle", 14),
      // Straight into a canvas fillStyle, so anything that is not a plain hex
      // colour is refused rather than passed through.
      color: /^#[0-9a-f]{6}$/i.test(a.color || "") ? (a.color as string) : "#8fe4ff",
      seen: ago(a.last_seen_at),
    }))
    .filter((a) => a.name);

  type MsgRow = { speaker: string | null; body: string | null; kind: string | null; created_at: string | null };
  out.messages = rows<MsgRow>(msgRes as PromiseSettledResult<{ data: MsgRow[] | null }>)
    .map((m) => ({
      speaker: clip(m.speaker || "—", 18),
      body: clip(m.body, 96),
      kind: clip(m.kind, 10),
      when: ago(m.created_at),
    }))
    .filter((m) => m.body);

  out.counts = {
    photos: out.photos.length,
    crew: out.crew.length,
    agents: out.agents.length,
    messages: out.messages.length,
    withImage: out.photos.filter((p) => p.img).length,
  };

  const allFailed = [photoRes, userRes, agentRes, msgRes].every((r) => r.status === "rejected");
  if (allFailed) out.error = "no link to the hub";
  return out;
}
