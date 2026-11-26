// vibe-build: the server half of Build mode.
//
// Somebody standing in a world types "make the zipline twice as fast". This
// function checks they are an admin, files a row in `vibe_builds`, and
// dispatches `.github/workflows/build-mode.yml`, where a Claude Code agent
// makes the change on a branch, fenced into that world's files, and ships it
// to main once typecheck and build pass.
//
// Nothing writes back from the runner. Every `list` asks GitHub how the
// unfinished runs are doing and updates the rows, so the runner needs no
// Supabase key and this function needs no webhook.
//
// Actions (all admin only):
//   status   {}                                   -> { admin, configured }
//   create   { prompt, mode, ship, billing, route, scope } -> { build }
//   list     { limit? }                           -> { builds }  (refreshes live ones)
//   ship     { id }                               -> merge a held branch into main
//   discard  { id }                               -> delete a held branch
//   cancel   { id }                               -> stop a queued or running build
//   retry    { id, prompt? }                      -> the same ask again (optionally edited)
//   undo     { id }                               -> a checked revert of a shipped build
//
// Secrets: BUILD_GITHUB_TOKEN, a fine-grained token on the repo with
// Actions: read and write, Contents: read and write. It never leaves here.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const REPO = Deno.env.get("BUILD_GITHUB_REPO") ?? "jackmielke/vibe-verse";
const WORKFLOW = "build-mode.yml";
const SCOPES = new Set(["island"]);
const DAILY_LIMIT = 30;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "content-type": "application/json" },
  });
}

type Supa = ReturnType<typeof createClient>;

interface Build {
  id: string;
  scope: string;
  prompt: string;
  route: string | null;
  ship: boolean;
  mode: "fast" | "smart";
  status: string;
  branch: string;
  run_id: number | null;
  run_url: string | null;
  summary: string | null;
  head_sha: string | null;
  requester_name: string | null;
  created_at: string;
  updated_at: string;
  /** Not stored: what a live run is doing right now. */
  step?: string | null;
}

const LIVE = new Set(["queued", "running"]);

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

function ghToken(): string | null {
  return Deno.env.get("BUILD_GITHUB_TOKEN") ?? null;
}

async function gh(path: string, init: RequestInit = {}): Promise<Response> {
  const token = ghToken();
  if (!token) throw new Error("Build mode is not set up yet: BUILD_GITHUB_TOKEN is missing.");
  return await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
      "user-agent": "vibe-build",
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
  });
}

async function ghJson<T>(path: string): Promise<T | null> {
  const r = await gh(path);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GitHub ${r.status} on ${path}: ${(await r.text()).slice(0, 200)}`);
  return (await r.json()) as T;
}

interface Run {
  id: number;
  status: string;
  conclusion: string | null;
  html_url: string;
  display_title: string;
}

async function findRun(build: Build): Promise<Run | null> {
  if (build.run_id) return await ghJson<Run>(`/repos/${REPO}/actions/runs/${build.run_id}`);
  const list = await ghJson<{ workflow_runs: Run[] }>(
    `/repos/${REPO}/actions/workflows/${WORKFLOW}/runs?event=workflow_dispatch&per_page=40`,
  );
  return list?.workflow_runs.find((r) => r.display_title === `build ${build.id}`) ?? null;
}

/** Ask GitHub how a live build is doing, and write down what it says. */
async function refresh(supabase: Supa, build: Build): Promise<Build> {
  if (!LIVE.has(build.status)) return build;
  const run = await findRun(build);
  const patch: Partial<Build> = {};

  if (!run) {
    // Dispatch is accepted before the run exists; give it a few minutes.
    if (Date.now() - Date.parse(build.created_at) > 10 * 60_000) {
      patch.status = "failed";
      patch.summary = "The build never started on GitHub.";
    }
  } else {
    patch.run_id = run.id;
    patch.run_url = run.html_url;
    if (run.status !== "completed") {
      patch.status = run.status === "queued" || run.status === "waiting" ? "queued" : "running";
      build.step = await currentStep(run.id).catch(() => null);
    } else {
      const branch = await ghJson<{ commit: { sha: string; commit: { message: string } } }>(
        `/repos/${REPO}/branches/${encodeURIComponent(build.branch)}`,
      );
      if (branch) {
        patch.head_sha = branch.commit.sha;
        patch.summary = branch.commit.commit.message
          .split("\nPrompt:")[0].trim().slice(0, 2000);
      }
      if (run.conclusion === "success") {
        if (!branch) {
          patch.status = "nochange";
          patch.summary = "The agent looked and decided nothing needed changing.";
        } else if (build.ship && (await onMain(branch.commit.sha))) {
          patch.status = "shipped";
        } else {
          patch.status = "ready";
        }
      } else if (branch) {
        // The branch is only pushed after typecheck and build pass, so a
        // failure after that point is the ship step: main moved underneath.
        patch.status = "ready";
        patch.summary = `${patch.summary ?? ""}\n\n(Checks passed but it could not land on main by itself. Ship it to try a merge.)`.trim();
      } else {
        patch.status = "failed";
        patch.summary = run.conclusion === "cancelled"
          ? "The build was cancelled."
          : "The build failed. The run log says why.";
      }
    }
  }

  if (Object.keys(patch).length === 0) return build;
  patch.updated_at = new Date().toISOString();
  const { data } = await supabase.from("vibe_builds").update(patch).eq("id", build.id)
    .select("*").single();
  return data ? { ...(data as Build), step: build.step } : { ...build, ...patch };
}

/** The name of the step a live run is on, in words a person can read. */
async function currentStep(runId: number): Promise<string | null> {
  const jobs = await ghJson<{ jobs: { steps?: { name: string; status: string }[] }[] }>(
    `/repos/${REPO}/actions/runs/${runId}/jobs`,
  );
  const steps = jobs?.jobs?.[0]?.steps ?? [];
  const live = steps.find((s) => s.status === "in_progress");
  const name = live?.name ?? null;
  if (!name) return null;
  return STEP_WORDS[name] ?? name;
}

const STEP_WORDS: Record<string, string> = {
  "Install": "Installing",
  "Pick the fence": "Getting ready",
  "Install Claude Code": "Getting ready",
  "Make the change": "Claude is coding",
  "Undo an earlier build": "Undoing",
  "Stay inside the fence": "Checking what changed",
  "Typecheck": "Typechecking",
  "Build": "Building the site",
  "Commit to the build branch": "Committing",
  "Ship to main": "Shipping to main",
};

async function onMain(sha: string): Promise<boolean> {
  const cmp = await ghJson<{ status: string }>(`/repos/${REPO}/compare/${sha}...main`);
  return cmp?.status === "identical" || cmp?.status === "ahead";
}

// ---------------------------------------------------------------------------
// Who is asking
// ---------------------------------------------------------------------------

async function mustBeAdmin(supabase: Supa, req: Request) {
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data } = await supabase.auth.getUser(token);
  const user = data?.user;
  if (!user) throw new Error("Sign in first.");
  const { data: admin } = await supabase.rpc("has_role", { _user_id: user.id, _role: "admin" });
  if (!admin) throw new Error("Build mode is for admins.");
  const { data: row } = await supabase.from("users").select("name")
    .eq("auth_user_id", user.id).maybeSingle();
  return { id: user.id, name: (row?.name as string | null) ?? user.email?.split("@")[0] ?? "admin" };
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function create(
  supabase: Supa,
  who: { id: string; name: string },
  body: Record<string, unknown>,
  revertSha = "",
) {
  const prompt = String(body.prompt ?? "").trim();
  if (prompt.length < 3) throw new Error("Say what to change.");
  if (prompt.length > 4000) throw new Error("Keep it under 4,000 characters.");
  const scope = String(body.scope ?? "island");
  if (!SCOPES.has(scope)) throw new Error(`Build mode does not cover "${scope}" yet.`);
  const mode = body.mode === "smart" ? "smart" : "fast";
  const ship = body.ship !== false;
  const billing = body.billing === "plan" ? "plan" : "api";
  const route = typeof body.route === "string" ? body.route.slice(0, 300) : null;

  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const { count } = await supabase.from("vibe_builds").select("id", { count: "exact", head: true })
    .eq("requested_by", who.id).gte("created_at", since);
  if ((count ?? 0) >= DAILY_LIMIT) throw new Error(`That is ${DAILY_LIMIT} builds today. Tomorrow.`);

  const id = crypto.randomUUID();
  const branch = `build/${id.slice(0, 8)}`;
  const { data: build, error } = await supabase.from("vibe_builds").insert({
    id, scope, prompt, route, ship, mode, branch,
    requested_by: who.id, requester_name: who.name,
  }).select("*").single();
  if (error) throw new Error(error.message);

  const r = await gh(`/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`, {
    method: "POST",
    body: JSON.stringify({
      ref: "main",
      inputs: {
        build_id: id,
        prompt,
        scope,
        mode,
        ship: ship ? "true" : "false",
        route: route ?? "",
        requested_by: who.name,
        billing,
        revert_sha: revertSha,
      },
    }),
  });
  if (!r.ok) {
    const why = (await r.text()).slice(0, 300);
    await supabase.from("vibe_builds").update({ status: "failed", summary: `GitHub refused the dispatch: ${why}` })
      .eq("id", id);
    throw new Error(`GitHub refused the build (${r.status}). ${why}`);
  }
  return { build };
}

async function list(supabase: Supa, body: Record<string, unknown>) {
  const limit = Math.min(Number(body.limit) || 20, 100);
  const offset = Math.max(0, Number(body.offset) || 0);
  const { data, error, count } = await supabase.from("vibe_builds").select("*", { count: "exact" })
    .order("created_at", { ascending: false }).range(offset, offset + limit - 1);
  if (error) throw new Error(error.message);
  const builds = await Promise.all(
    (data as Build[]).map((b) => refresh(supabase, b).catch(() => b)),
  );
  return { builds, total: count ?? builds.length };
}

async function load(supabase: Supa, id: unknown): Promise<Build> {
  const { data } = await supabase.from("vibe_builds").select("*").eq("id", String(id)).maybeSingle();
  if (!data) throw new Error("No such build.");
  return data as Build;
}

async function ship(supabase: Supa, body: Record<string, unknown>) {
  const build = await load(supabase, body.id);
  if (build.status !== "ready") throw new Error(`That build is ${build.status}, not waiting to ship.`);
  const r = await gh(`/repos/${REPO}/merges`, {
    method: "POST",
    body: JSON.stringify({
      base: "main",
      head: build.branch,
      commit_message: `Ship build mode ${build.branch}\n\n${(build.summary ?? build.prompt).slice(0, 500)}`,
    }),
  });
  if (r.status === 409) throw new Error("It conflicts with what is on main now. Ask again and it will be rebuilt on top.");
  if (!r.ok && r.status !== 204) throw new Error(`GitHub refused the merge (${r.status}).`);
  const { data } = await supabase.from("vibe_builds")
    .update({ status: "shipped", updated_at: new Date().toISOString() })
    .eq("id", build.id).select("*").single();
  return { build: data };
}

async function discard(supabase: Supa, body: Record<string, unknown>) {
  const build = await load(supabase, body.id);
  if (build.status !== "ready") throw new Error(`That build is ${build.status}; only a waiting one can be thrown away.`);
  await gh(`/repos/${REPO}/git/refs/heads/${build.branch}`, { method: "DELETE" });
  const { data } = await supabase.from("vibe_builds")
    .update({ status: "discarded", updated_at: new Date().toISOString() })
    .eq("id", build.id).select("*").single();
  return { build: data };
}

async function cancel(supabase: Supa, body: Record<string, unknown>) {
  let build = await load(supabase, body.id);
  if (!LIVE.has(build.status)) throw new Error(`That build is already ${build.status}.`);
  if (!build.run_id) build = await refresh(supabase, build);
  if (!build.run_id) throw new Error("GitHub has not started it yet. Try again in a few seconds.");
  const r = await gh(`/repos/${REPO}/actions/runs/${build.run_id}/cancel`, { method: "POST" });
  if (!r.ok && r.status !== 409) throw new Error(`GitHub refused to stop it (${r.status}).`);
  const { data } = await supabase.from("vibe_builds")
    .update({ status: "failed", summary: "Stopped.", updated_at: new Date().toISOString() })
    .eq("id", build.id).select("*").single();
  return { build: data };
}

async function retry(supabase: Supa, who: { id: string; name: string }, body: Record<string, unknown>) {
  const old = await load(supabase, body.id);
  const prompt = typeof body.prompt === "string" && body.prompt.trim() ? body.prompt : old.prompt;
  return await create(supabase, who, {
    prompt, mode: body.mode ?? old.mode, ship: body.ship ?? old.ship,
    billing: body.billing, scope: old.scope, route: old.route,
  });
}

async function undo(supabase: Supa, who: { id: string; name: string }, body: Record<string, unknown>) {
  const old = await load(supabase, body.id);
  if (old.status !== "shipped" || !old.head_sha) throw new Error("Only a build that shipped can be undone.");
  return await create(supabase, who, {
    prompt: `Undo: ${old.prompt}`.slice(0, 4000), mode: "fast", ship: true,
    scope: old.scope, route: old.route,
  }, old.head_sha);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const who = await mustBeAdmin(supabase, req);
    const action = String(body.action ?? "list");
    let data: unknown;
    if (action === "status") data = { admin: true, configured: !!ghToken(), repo: REPO };
    else if (action === "create") data = await create(supabase, who, body);
    else if (action === "list") data = await list(supabase, body);
    else if (action === "ship") data = await ship(supabase, body);
    else if (action === "discard") data = await discard(supabase, body);
    else if (action === "cancel") data = await cancel(supabase, body);
    else if (action === "retry") data = await retry(supabase, who, body);
    else if (action === "undo") data = await undo(supabase, who, body);
    else throw new Error(`Unknown action ${action}`);
    return reply({ ok: true, data });
  } catch (e) {
    return reply({ ok: false, error: (e as Error).message }, 400);
  }
});
