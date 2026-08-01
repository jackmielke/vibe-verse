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
export interface VibeProfile {
  name: string; headline: string; bio: string; interests: string;
  resident: boolean; img: HTMLImageElement | null;
}
export interface VibeHolder { name: string; kind: string; balance: number; mine: boolean }
export interface VibeLedgerRow { from: string; to: string; amount: number; reason: string; when: string }
export interface VibeTreasury {
  mine: number | null; supply: number; holders: VibeHolder[]; ledger: VibeLedgerRow[];
}

export interface VibeversePayload {
  photos: VibePhoto[];
  crew: VibeCrew[];
  agents: VibeAgent[];
  messages: VibeMessage[];
  profiles: VibeProfile[];
  treasury: VibeTreasury;
  counts: Record<string, number>;
  error?: string;
}

/** Trim anything headed for a 1000-pixel-wide panel. */
function clip(s: unknown, n: number): string {
  let t = (s == null ? "" : String(s)).replace(/\s+/g, " ").trim();
  /* A good few imported bios begin with a literal "[Photo: " that came in with
     the scrape. It is not part of what anybody wrote about themselves. */
  t = t.replace(/^\[Photo:\s*/i, "").replace(/\]$/, "");
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

/**
 * @param viewerId the signed-in profile id, when there is one. Only used to
 *   mark which balance is yours — the treasury is public either way.
 */
export async function loadVibeverse(viewerId?: string | null): Promise<VibeversePayload> {
  const out: VibeversePayload = {
    photos: [], crew: [], agents: [], messages: [], profiles: [],
    treasury: { mine: null, supply: 0, holders: [], ledger: [] },
    counts: {},
  };

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

  /* ---- profiles and the treasury.
     A second wave, after the first has landed: these are the pages furthest
     from the front of the terminal, and holding the gallery back on a slow
     ledger query would be the wrong trade. Same settle-independently rule. */
  const [profRes, balRes, ledgerRes] = await Promise.allSettled([
    supabase.from("users")
      .select("name, headline, bio, interests_skills, avatar_url, is_vibe_resident")
      .not("name", "is", null)
      .not("bio", "is", null)
      .not("avatar_url", "is", null)
      .limit(24),
    supabase.from("vibe_balances")
      .select("owner_kind, owner_ref, balance")
      .order("balance", { ascending: false })
      .limit(20),
    supabase.from("vibe_ledger")
      .select("from_kind, from_ref, to_kind, to_ref, amount, reason, memo, created_at")
      .order("created_at", { ascending: false })
      .limit(12),
  ]);

  type ProfRow = {
    name: string | null; headline: string | null; bio: string | null;
    interests_skills: string[] | null; avatar_url: string | null; is_vibe_resident: boolean | null;
  };
  const profRows = rows<ProfRow>(profRes as PromiseSettledResult<{ data: ProfRow[] | null }>);
  /* Avatars are third-party CDNs — Telegram, X, wherever — and most of them do
     not send CORS headers. loadImage turns that into a null rather than a
     tainted canvas, and the card falls back to drawing initials. */
  const avatars = await Promise.all(profRows.map((u) => loadImage(u.avatar_url || "")));
  out.profiles = profRows.map((u, i) => ({
    name: clip(u.name, 30),
    headline: clip(u.headline, 46),
    bio: clip(u.bio, 300),
    interests: clip((u.interests_skills || []).slice(0, 6).join(" · "), 90),
    resident: !!u.is_vibe_resident,
    img: avatars[i],
  })).filter((u) => u.name);

  type BalRow = { owner_kind: string | null; owner_ref: string | null; balance: number | null };
  const balRows = rows<BalRow>(balRes as PromiseSettledResult<{ data: BalRow[] | null }>);

  /* Balances key on a bare uuid, so the names come from a second lookup over
     both possible owner kinds. An id that resolves to nothing is shown as a
     short id rather than dropped — a treasury that hides rows it cannot label
     misreports the supply. */
  const userIds = balRows.filter((b) => b.owner_kind === "user").map((b) => b.owner_ref!).filter(Boolean);
  const agentIds = balRows.filter((b) => b.owner_kind === "agent").map((b) => b.owner_ref!).filter(Boolean);
  const [nameU, nameA] = await Promise.allSettled([
    userIds.length ? supabase.from("users").select("id, name").in("id", userIds) : Promise.resolve({ data: [] }),
    agentIds.length ? supabase.from("world_agents").select("id, name").in("id", agentIds) : Promise.resolve({ data: [] }),
  ]);
  const byId = new Map<string, string>();
  for (const r of [nameU, nameA]) {
    for (const row of rows<{ id: string; name: string | null }>(r as PromiseSettledResult<{ data: { id: string; name: string | null }[] | null }>)) {
      if (row?.id) byId.set(row.id, clip(row.name || "", 22));
    }
  }
  const label = (ref: string | null | undefined, kind?: string | null) => {
    if (!ref) return "—";
    if (kind === "system") return ref === "treasury" ? "TREASURY" : clip(ref, 18).toUpperCase();
    return byId.get(ref) || `${ref.slice(0, 6)}…`;
  };

  out.treasury.holders = balRows.map((b) => ({
    name: label(b.owner_ref, b.owner_kind) || "—",
    kind: b.owner_kind || "?",
    balance: Number(b.balance) || 0,
    mine: !!viewerId && b.owner_ref === viewerId,
  }));
  out.treasury.supply = out.treasury.holders.reduce((n, h) => n + h.balance, 0);
  const own = out.treasury.holders.find((h) => h.mine);
  out.treasury.mine = own ? own.balance : (viewerId ? 0 : null);

  type LedgerRow = {
    from_kind: string | null; from_ref: string | null; to_kind: string | null; to_ref: string | null;
    amount: number | null; reason: string | null; memo: string | null; created_at: string | null;
  };
  out.treasury.ledger = rows<LedgerRow>(ledgerRes as PromiseSettledResult<{ data: LedgerRow[] | null }>)
    .map((l) => ({
      from: label(l.from_ref, l.from_kind),
      to: label(l.to_ref, l.to_kind),
      amount: Number(l.amount) || 0,
      reason: clip(l.memo || l.reason, 46),
      when: ago(l.created_at),
    }));

  out.counts = {
    profiles: out.profiles.length,
    holders: out.treasury.holders.length,
    photos: out.photos.length,
    crew: out.crew.length,
    agents: out.agents.length,
    messages: out.messages.length,
    withImage: out.photos.filter((p) => p.img).length,
  };

  const allFailed = [photoRes, userRes, agentRes, msgRes, profRes, balRes]
    .every((r) => r.status === "rejected");
  if (allFailed) out.error = "no link to the hub";
  return out;
}
