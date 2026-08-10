// vibe-portal-submit — the desk where a stranger's game comes in.
//
// `vibe-portal` is the money side: it holds the budgets and pays them out.
// This is the door side: it takes a link, works out whether there is a game
// behind it, copies one if it has to, and files the result for a human to look
// at. The two are separate functions because they have nothing in common
// except a table — one is called by every player of every game, the other a
// handful of times a week by somebody with an idea.
//
// Actions:
//   submit  { url, label? }                  -> resolves, mirrors, files a pending row
//   mine    {}                               -> your own submissions, including the failures
//   queue   { status? }                      -> admin: everything, newest first
//   review  { id, action, budgets?, note? }  -> admin: approve (writes the game) or reject
//   resync  { slug }                         -> admin: re-pin a github game to its latest commit
//
// `mine` and `queue` could have been plain PostgREST reads — the table has
// select policies that say exactly the same thing, and they are still there as
// a second lock. They are actions instead so that every path in and out of the
// submissions table runs through one file with one idea of who is asking. The
// policies mean a mistake here is not a leak; the actions mean there is one
// place to look.
//
// The thing this function must never become: a way to write `embed_url` or
// `origin` from a browser. Those two columns *are* the approval decision — the
// URL we frame and the one origin allowed to talk to us — which is why the
// submissions table has no INSERT policy and everything here runs under the
// service role after checking who is asking.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

import { SLUG_RE, parseSubmission, slugify } from "./github.ts";
import { mirrorFiles, resolveRepo } from "./mirror.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const BUCKET = "portal-games";

/**
 * Budgets a game gets when an admin does not pick.
 *
 * Deliberately modest. The point of the portal is that saying yes is cheap and
 * reversible, and a first-day allowance that would sting if the game turned out
 * to be a coin faucet is not a default, it is a decision — so the default is
 * the number you would not think twice about.
 */
const DEFAULT_BUDGETS = {
  max_award: 10,
  session_budget: 50,
  player_daily: 100,
  daily_budget: 800,
};

/** How many submissions one account may file in a day. */
const SUBMISSIONS_PER_DAY = 10;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false } },
    );
    const body = await req.json().catch(() => ({}));
    const action = String(body?.action ?? "");

    switch (action) {
      case "submit": return ok(await submit(supabase, req, body));
      case "mine":   return ok(await mine(supabase, req));
      case "queue":  return ok(await queue(supabase, req, body));
      case "review": return ok(await review(supabase, req, body));
      case "resync": return ok(await resync(supabase, req, body));
      default: return json({ error: `unknown action: ${action}` }, 400);
    }
  } catch (e) {
    return json({ error: String((e as Error).message ?? e) }, 400);
  }
});

function ok(data: unknown) { return json({ ok: true, data }); }
function json(o: unknown, status = 200) {
  return new Response(JSON.stringify(o), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

type Supa = ReturnType<typeof createClient>;

// ---------------------------------------------------------------------------
// Who is asking
// ---------------------------------------------------------------------------

interface Caller {
  authUid: string;
  /** `public.users.id` — what the submissions table points at. */
  userId: string | null;
  isAdmin: boolean;
}

/**
 * Sign-in is required to submit, and this is where that is true.
 *
 * `verify_jwt` on the function itself is not enough: an anonymous browser sends
 * the project's publishable key as its JWT and sails through it. The question
 * that matters — *which person is this* — only has an answer after `getUser`.
 */
async function whoAsks(supabase: Supa, req: Request): Promise<Caller> {
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data } = await supabase.auth.getUser(token);
  const authUid = data?.user?.id;
  if (!authUid) {
    throw new Error("Sign in first — a submission needs somebody's name on it.");
  }
  const { data: row } = await supabase.from("users")
    .select("id").eq("auth_user_id", authUid).maybeSingle();
  const { data: admin } = await supabase.rpc("has_role", { _user_id: authUid, _role: "admin" });
  return { authUid, userId: (row?.id as string) ?? null, isAdmin: !!admin };
}

async function mustBeAdmin(supabase: Supa, req: Request): Promise<Caller> {
  const caller = await whoAsks(supabase, req);
  if (!caller.isAdmin) throw new Error("That is an admin action.");
  return caller;
}

// ---------------------------------------------------------------------------
// submit
// ---------------------------------------------------------------------------

async function submit(supabase: Supa, req: Request, b: Record<string, unknown>) {
  const caller = await whoAsks(supabase, req);
  const raw = String(b.url ?? "").slice(0, 500);
  const label = String(b.label ?? "").slice(0, 80).trim() || null;

  const { target, error } = parseSubmission(raw);
  if (error || !target) throw new Error(error ?? "could not read that link");

  await enforceDailyLimit(supabase, caller.userId);

  if (target.kind === "hosted") {
    return await submitHosted(supabase, caller, raw, label, target.embedUrl, target.origin);
  }
  return await submitGitHub(supabase, caller, raw, label, target.owner, target.repo, target.ref);
}

async function enforceDailyLimit(supabase: Supa, userId: string | null) {
  if (!userId) return;
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { count } = await supabase.from("vibe_portal_submissions")
    .select("id", { count: "exact", head: true })
    .eq("submitter_id", userId).gte("created_at", since);
  if ((count ?? 0) >= SUBMISSIONS_PER_DAY) {
    throw new Error(
      `That is ${SUBMISSIONS_PER_DAY} submissions today, which is the limit. Try again tomorrow.`,
    );
  }
}

/**
 * A game that is already on the internet.
 *
 * Nothing is copied and nothing is checked beyond the shape of the URL, because
 * there is nothing we could check that would stay true — their deploy is theirs
 * to change a minute after we look. The review step is a person opening the
 * link, which is the only check that was ever meaningful here.
 */
async function submitHosted(
  supabase: Supa,
  caller: Caller,
  raw: string,
  label: string | null,
  embedUrl: string,
  origin: string,
) {
  const host = new URL(origin).hostname;
  const slug = await freeSlug(supabase, host.split(".")[0] || "game");

  const row = {
    submitted_url: raw,
    kind: "hosted",
    submitter_id: caller.userId,
    submitter_label: label,
    slug,
    title: prettyTitle(host.split(".")[0] ?? slug),
    tagline: null,
    author: label,
    author_url: null,
    embed_url: embedUrl,
    origin,
    uses_sdk: false,
    status: "pending",
    status_note:
      "Hosted on its own domain, so nothing was copied. A reviewer opens the link and plays it.",
    ...DEFAULT_BUDGETS,
  };

  const { data, error } = await supabase.from("vibe_portal_submissions")
    .insert(row).select("*").single();
  if (error) throw new Error(error.message);
  return { submission: data, preview: embedUrl };
}

/**
 * A game in a repository.
 *
 * Resolve, then copy, then file — in that order, and the copy happens now
 * rather than at approval on purpose. By the time this row reaches the queue
 * there is a URL an admin can click and play. Approving becomes a judgement
 * about a game somebody has actually seen, rather than a bet on a repository
 * name, and it costs one statement instead of a build.
 */
async function submitGitHub(
  supabase: Supa,
  caller: Caller,
  raw: string,
  label: string | null,
  owner: string,
  repo: string,
  ref?: string,
) {
  // Somebody submitting the same repo twice — usually because they fixed
  // something and want another look — should not get two rows in the queue.
  const fullName = `${owner}/${repo}`;
  const { data: existing } = await supabase.from("vibe_portal_submissions")
    .select("*").ilike("repo", fullName).in("status", ["pending", "approved"])
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (existing) {
    return {
      submission: existing,
      preview: existing.embed_url,
      alreadyKnown: true,
      note:
        existing.status === "approved"
          ? "That repository is already in the arcade."
          : "That repository is already waiting to be looked at.",
    };
  }

  const slug = await freeSlug(supabase, repo);

  let resolved;
  try {
    resolved = await resolveRepo(owner, repo, ref);
  } catch (e) {
    // A failure to resolve is still a row. The submitter needs to be told why,
    // and a row is how they are told — a thrown error would vanish the moment
    // they closed the tab.
    const note = String((e as Error).message ?? e);
    const { data } = await supabase.from("vibe_portal_submissions").insert({
      submitted_url: raw,
      kind: "github",
      submitter_id: caller.userId,
      submitter_label: label,
      repo: fullName,
      status: "failed",
      status_note: note,
    }).select("*").single();
    return { submission: data, failed: true, note };
  }

  const { facts, sha, plan, audit } = resolved;

  if (!audit.ok) {
    const { data } = await supabase.from("vibe_portal_submissions").insert({
      submitted_url: raw,
      kind: "github",
      submitter_id: caller.userId,
      submitter_label: label,
      repo: facts.fullName,
      repo_ref: resolved.ref,
      repo_sha: sha,
      entry_path: plan.root ? `${plan.root}/${plan.entry}` : plan.entry,
      license: facts.license,
      file_count: plan.files.length,
      total_bytes: plan.totalBytes,
      status: "failed",
      status_note: audit.note ?? "That page will not run as static files.",
    }).select("*").single();
    return { submission: data, failed: true, note: audit.note };
  }

  const bucket = supabase.storage.from(BUCKET);
  const mirror = await mirrorFiles(bucket, facts.owner, facts.repo, sha, slug, plan);

  // The entry failing is fatal; a font failing is not. The distinction is the
  // difference between a broken game and a slightly ugly one, and conflating
  // them would reject games for missing an .eot nobody has needed since 2013.
  const entryFailed = mirror.failed.some((f) => f.path === plan.entry);
  if (entryFailed || mirror.uploaded === 0) {
    await removePrefix(supabase, mirror.prefix);
    const why = mirror.failed[0]?.why ?? "nothing could be copied";
    const { data } = await supabase.from("vibe_portal_submissions").insert({
      submitted_url: raw,
      kind: "github",
      submitter_id: caller.userId,
      submitter_label: label,
      repo: facts.fullName,
      repo_ref: resolved.ref,
      repo_sha: sha,
      status: "failed",
      status_note: `Could not copy the game: ${why}`,
    }).select("*").single();
    return { submission: data, failed: true, note: why };
  }

  const embedUrl = publicUrl(`${mirror.prefix}/${plan.entry}`);
  const notes = [
    `Copied ${mirror.uploaded} files (${Math.round(mirror.bytes / 1024)} KB) from ${sha.slice(0, 7)}.`,
    audit.note,
    mirror.failed.length ? `${mirror.failed.length} file(s) could not be copied.` : null,
    audit.usesSdk
      ? null
      : "This game does not include vibeverse.js, so it cannot pay anybody yet — it is playable, and adding the SDK is four lines.",
  ].filter(Boolean).join(" ");

  const { data, error } = await supabase.from("vibe_portal_submissions").insert({
    submitted_url: raw,
    kind: "github",
    submitter_id: caller.userId,
    submitter_label: label,
    slug,
    title: prettyTitle(facts.repo),
    tagline: (facts.description ?? "").slice(0, 140) || null,
    author: label ?? facts.owner,
    author_url: facts.ownerUrl,
    repo: facts.fullName,
    repo_ref: resolved.ref,
    repo_sha: sha,
    entry_path: plan.root ? `${plan.root}/${plan.entry}` : plan.entry,
    license: facts.license,
    file_count: mirror.uploaded,
    total_bytes: mirror.bytes,
    embed_url: embedUrl,
    origin: storageOrigin(),
    uses_sdk: audit.usesSdk,
    status: "pending",
    status_note: notes,
    ...DEFAULT_BUDGETS,
  }).select("*").single();
  if (error) throw new Error(error.message);

  return { submission: data, preview: embedUrl, mirror };
}

// ---------------------------------------------------------------------------
// reading the desk
// ---------------------------------------------------------------------------

/** Your own submissions — the failures very much included. */
async function mine(supabase: Supa, req: Request) {
  const caller = await whoAsks(supabase, req);
  if (!caller.userId) return { submissions: [] };
  const { data } = await supabase.from("vibe_portal_submissions")
    .select("*").eq("submitter_id", caller.userId)
    .order("created_at", { ascending: false }).limit(50);
  return { submissions: data ?? [] };
}

async function queue(supabase: Supa, req: Request, b: Record<string, unknown>) {
  await mustBeAdmin(supabase, req);
  const status = String(b.status ?? "pending");
  let q = supabase.from("vibe_portal_submissions").select("*")
    .order("created_at", { ascending: false }).limit(200);
  if (status !== "all") q = q.eq("status", status);
  const { data } = await q;

  // The games list rides along: the queue page is also where a resync is
  // triggered, and fetching it separately would be a second round trip for a
  // list of five things.
  const { data: games } = await supabase.from("vibe_portal_games")
    .select("slug, title, active, source_kind, repo, repo_ref, repo_sha, mirrored_at, uses_sdk, max_award, daily_budget")
    .order("created_at", { ascending: false });

  return { submissions: data ?? [], games: games ?? [] };
}

// ---------------------------------------------------------------------------
// review
// ---------------------------------------------------------------------------

async function review(supabase: Supa, req: Request, b: Record<string, unknown>) {
  const caller = await mustBeAdmin(supabase, req);
  const id = String(b.id ?? "");
  // `decision`, not `action` — the envelope already owns `action`, and a body
  // carrying both means whichever the client spread last wins. See the note on
  // `reviewPortalSubmission` in src/portal/api.ts.
  const decision = String(b.decision ?? "");
  if (!id) throw new Error("id required");

  const { data: sub } = await supabase.from("vibe_portal_submissions")
    .select("*").eq("id", id).maybeSingle();
  if (!sub) throw new Error("no such submission");

  if (decision === "reject") {
    // The bytes go too. Storage we are holding for a game nobody will play is
    // just cost, and a rejected submitter who fixes the problem resubmits.
    if (sub.kind === "github" && sub.slug && sub.repo_sha) {
      await removePrefix(supabase, `${sub.slug}/${sub.repo_sha}`);
    }
    const { data } = await supabase.from("vibe_portal_submissions").update({
      status: "rejected",
      status_note: String(b.note ?? "").slice(0, 500) || "Not a fit for the arcade.",
      reviewed_by: caller.userId,
      reviewed_at: new Date().toISOString(),
    }).eq("id", id).select("*").single();
    return { submission: data };
  }

  if (decision !== "approve") throw new Error("action must be approve or reject");
  if (sub.status === "failed") throw new Error("that submission never resolved — nothing to approve");
  if (!sub.embed_url || !sub.origin || !sub.slug) throw new Error("that submission has no game in it");

  const budgets = {
    max_award: clamp(b.maxAward, sub.max_award ?? DEFAULT_BUDGETS.max_award, 1, 500),
    session_budget: clamp(b.sessionBudget, sub.session_budget ?? DEFAULT_BUDGETS.session_budget, 1, 2000),
    player_daily: clamp(b.playerDaily, sub.player_daily ?? DEFAULT_BUDGETS.player_daily, 1, 5000),
    daily_budget: clamp(b.dailyBudget, sub.daily_budget ?? DEFAULT_BUDGETS.daily_budget, 1, 100000),
  };

  // The slug was reserved when the submission was filed; something else may
  // have taken it since. Check rather than let the insert fail on a constraint.
  const slug = await freeSlug(supabase, sub.slug as string, sub.slug as string);

  const { error } = await supabase.from("vibe_portal_games").upsert({
    slug,
    title: String(b.title ?? sub.title ?? slug).slice(0, 80),
    tagline: (b.tagline as string | undefined) ?? sub.tagline,
    author: (b.author as string | undefined) ?? sub.author,
    author_url: sub.author_url,
    embed_url: sub.embed_url,
    origin: sub.origin,
    ...budgets,
    active: true,
    source_kind: sub.kind,
    submission_id: sub.id,
    repo: sub.repo,
    repo_ref: sub.repo_ref,
    repo_sha: sub.repo_sha,
    entry_path: sub.entry_path,
    mirror_prefix: sub.kind === "github" ? `${slug}/${sub.repo_sha}` : null,
    mirrored_at: sub.kind === "github" ? new Date().toISOString() : null,
    uses_sdk: sub.uses_sdk,
    note: String(b.note ?? "").slice(0, 300) || `Approved from submission ${sub.id}.`,
  }, { onConflict: "slug" });
  if (error) throw new Error(error.message);

  const { data } = await supabase.from("vibe_portal_submissions").update({
    status: "approved",
    slug,
    ...budgets,
    reviewed_by: caller.userId,
    reviewed_at: new Date().toISOString(),
  }).eq("id", id).select("*").single();

  return { submission: data, route: `/play/${slug}` };
}

// ---------------------------------------------------------------------------
// resync
// ---------------------------------------------------------------------------

/**
 * Move a mirrored game to whatever its branch points at now.
 *
 * This is the whole "GitHub sync" story, and it is deliberately a button rather
 * than a webhook. A webhook means the arcade changes because somebody else
 * pushed, which is the one property the pinned commit exists to prevent. A
 * button means a person decided.
 *
 * The new commit is copied to its own prefix and the row is moved in one
 * statement at the end, so a player mid-game is never served half of each.
 */
async function resync(supabase: Supa, req: Request, b: Record<string, unknown>) {
  await mustBeAdmin(supabase, req);
  const slug = String(b.slug ?? "");
  if (!slug) throw new Error("slug required");

  const { data: game } = await supabase.from("vibe_portal_games")
    .select("*").eq("slug", slug).maybeSingle();
  if (!game) throw new Error("no such game");
  if (game.source_kind !== "github" || !game.repo) {
    throw new Error("that game is not mirrored from a repository");
  }

  const [owner, repo] = String(game.repo).split("/");
  const resolved = await resolveRepo(owner, repo, game.repo_ref ?? undefined);
  if (resolved.sha === game.repo_sha) {
    return { changed: false, sha: resolved.sha, note: "Already on the latest commit." };
  }
  if (!resolved.audit.ok) {
    throw new Error(`The latest commit will not run as static files: ${resolved.audit.note}`);
  }

  const mirror = await mirrorFiles(
    supabase.storage.from(BUCKET), resolved.facts.owner, resolved.facts.repo,
    resolved.sha, slug, resolved.plan,
  );
  if (mirror.failed.some((f) => f.path === resolved.plan.entry) || mirror.uploaded === 0) {
    await removePrefix(supabase, mirror.prefix);
    throw new Error(`Could not copy the new commit: ${mirror.failed[0]?.why ?? "nothing copied"}`);
  }

  const oldPrefix = game.mirror_prefix as string | null;
  const { error } = await supabase.from("vibe_portal_games").update({
    repo_sha: resolved.sha,
    entry_path: resolved.plan.root
      ? `${resolved.plan.root}/${resolved.plan.entry}`
      : resolved.plan.entry,
    embed_url: publicUrl(`${mirror.prefix}/${resolved.plan.entry}`),
    mirror_prefix: mirror.prefix,
    mirrored_at: new Date().toISOString(),
    uses_sdk: resolved.audit.usesSdk,
  }).eq("slug", slug);
  if (error) throw new Error(error.message);

  // Only once the row has moved. A failure before this point leaves the old
  // build serving, which is the right way round to fail.
  if (oldPrefix && oldPrefix !== mirror.prefix) await removePrefix(supabase, oldPrefix);

  return {
    changed: true,
    from: game.repo_sha,
    sha: resolved.sha,
    uploaded: mirror.uploaded,
    usesSdk: resolved.audit.usesSdk,
  };
}

// ---------------------------------------------------------------------------
// odds and ends
// ---------------------------------------------------------------------------

function storageOrigin(): string {
  return new URL(Deno.env.get("SUPABASE_URL")!).origin;
}

function publicUrl(key: string): string {
  const base = Deno.env.get("SUPABASE_URL")!.replace(/\/$/, "");
  return `${base}/storage/v1/object/public/${BUCKET}/${key.split("/").map(encodeURIComponent).join("/")}`;
}

function clamp(value: unknown, fallback: number, lo: number, hi: number): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

/** `2048` -> `2048`, `my-cool-game` -> `My Cool Game`. */
function prettyTitle(name: string): string {
  const words = String(name).replace(/[-_]+/g, " ").trim();
  if (!words) return "Untitled";
  return words.replace(/\b[a-z]/g, (c) => c.toUpperCase()).slice(0, 80);
}

/**
 * A slug nothing else is using.
 *
 * Both tables are consulted: a pending submission has reserved its slug even
 * though no game exists yet, and letting a second submission pick the same one
 * would produce two rows that cannot both be approved.
 */
async function freeSlug(supabase: Supa, name: string, allow?: string): Promise<string> {
  const [{ data: games }, { data: subs }] = await Promise.all([
    supabase.from("vibe_portal_games").select("slug"),
    supabase.from("vibe_portal_submissions").select("slug").in("status", ["pending", "approved"]),
  ]);
  const taken = new Set<string>();
  for (const r of (games ?? []) as { slug: string }[]) taken.add(r.slug);
  for (const r of (subs ?? []) as { slug: string | null }[]) if (r.slug) taken.add(r.slug);
  if (allow) taken.delete(allow);

  const slug = slugify(name, taken);
  if (!SLUG_RE.test(slug)) throw new Error(`could not make a route out of "${name}"`);
  return slug;
}

/**
 * Delete everything under a prefix.
 *
 * Storage has no recursive delete, so this walks. It is used on rejection and
 * after a resync, and it is deliberately best-effort: a leftover object costs
 * a fraction of a cent, and failing a review because a cleanup 500'd would be
 * the tail wagging the dog.
 */
async function removePrefix(supabase: Supa, prefix: string): Promise<void> {
  const bucket = supabase.storage.from(BUCKET);
  const keys: string[] = [];

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 8) return;
    const { data } = await bucket.list(dir, { limit: 1000 });
    for (const entry of data ?? []) {
      const key = `${dir}/${entry.name}`;
      // Storage marks folders with a null id and no metadata.
      if (entry.id === null) await walk(key, depth + 1);
      else keys.push(key);
    }
  };

  try {
    await walk(prefix, 0);
    for (let i = 0; i < keys.length; i += 100) {
      await bucket.remove(keys.slice(i, i + 100));
    }
  } catch {
    /* Best effort. A stray object is cheaper than a failed review. */
  }
}
