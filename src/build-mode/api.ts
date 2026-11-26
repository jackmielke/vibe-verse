/**
 * Build mode, client side: a thin wrapper round the `vibe-build` function.
 *
 * Nothing here can change the site by itself. The function checks the caller
 * is an admin and holds the GitHub token; the agent runs in GitHub Actions.
 * This file only says what somebody asked for and reads back how it went.
 */
import { supabase } from "@/integrations/supabase/client";

export type BuildMode = "fast" | "smart";

/** Who pays for the agent: console API credits, or the Claude plan. */
export type BuildBilling = "api" | "plan";

export type BuildStatus =
  | "queued"
  | "running"
  | "shipped"
  | "ready"
  | "failed"
  | "nochange"
  | "discarded";

export interface Build {
  id: string;
  scope: string;
  prompt: string;
  route: string | null;
  ship: boolean;
  mode: BuildMode;
  status: BuildStatus;
  branch: string;
  run_id: number | null;
  run_url: string | null;
  summary: string | null;
  head_sha: string | null;
  requester_name: string | null;
  created_at: string;
  updated_at: string;
  /** What a live build is doing right now ("Claude is coding"). Not stored. */
  step?: string | null;
}

/** The worlds build mode can change, and the routes that count as each. */
export const BUILD_SCOPES = {
  island: {
    name: "Vibe Island",
    routes: ["/city", "/live", "/world"],
  },
} as const;

export type BuildScope = keyof typeof BUILD_SCOPES;

export function scopeForPath(pathname: string): BuildScope | null {
  for (const [key, s] of Object.entries(BUILD_SCOPES)) {
    if ((s.routes as readonly string[]).includes(pathname)) return key as BuildScope;
  }
  return null;
}

export const LIVE_STATUSES: BuildStatus[] = ["queued", "running"];

async function call<T>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await supabase.functions.invoke("vibe-build", {
    body: { ...payload, action },
  });
  if (error) {
    const res = (error as { context?: Response }).context;
    let msg: string | null = null;
    try {
      const body = res && typeof res.json === "function" ? await res.json() : null;
      msg = typeof body?.error === "string" ? body.error : null;
    } catch {
      /* the generic message will do */
    }
    throw new Error(msg ?? error.message);
  }
  if (!data?.ok) throw new Error(data?.error ?? "vibe-build error");
  return data.data as T;
}

export const buildStatus = () =>
  call<{ admin: boolean; configured: boolean; repo: string }>("status");

export const createBuild = (input: {
  prompt: string;
  mode: BuildMode;
  ship: boolean;
  billing: BuildBilling;
  scope: BuildScope;
  route: string;
}) => call<{ build: Build }>("create", input);

export const listBuilds = (limit = 20, offset = 0) =>
  call<{ builds: Build[]; total: number }>("list", { limit, offset });

export const shipBuild = (id: string) => call<{ build: Build }>("ship", { id });

export const discardBuild = (id: string) => call<{ build: Build }>("discard", { id });

export const cancelBuild = (id: string) => call<{ build: Build }>("cancel", { id });

export const retryBuild = (id: string, billing: BuildBilling) =>
  call<{ build: Build }>("retry", { id, billing });

export const undoBuild = (id: string) => call<{ build: Build }>("undo", { id });
