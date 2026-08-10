/**
 * Copying a repository's static files into our bucket.
 *
 * The impure half of the submission desk: `github.ts` decides what to copy,
 * this moves the bytes. Keeping the decision and the movement in separate files
 * is not tidiness — it is what lets the decision be tested without a network,
 * which is the half that can hurt somebody.
 *
 * Two things about GitHub that shape everything here:
 *
 *   * **The tree API gives you every path and size in one request.** So the
 *     whole plan — what gets copied, what gets skipped, whether it is too big —
 *     is settled before a single byte is fetched. A submission that is going to
 *     be refused costs one request, not four hundred.
 *   * **`raw.githubusercontent.com` serves everything as `text/plain`.** Which
 *     is exactly why the mirror exists, and it means every upload has to carry
 *     a content type we chose. Uploading with the type GitHub reports would
 *     reproduce the bug we are here to fix.
 */
import {
  type MirrorPlan,
  type TreeEntry,
  auditEntry,
  planMirror,
  pickEntry,
} from "./github.ts";

const API = "https://api.github.com";
const RAW = "https://raw.githubusercontent.com";

/**
 * How many files we fetch and upload at once.
 *
 * Not tuned so much as chosen to be obviously polite. A submission is a
 * background-feeling action a human is waiting on for a few seconds; eight in
 * flight copies 2048's thirty-odd files in about four rounds and does not look
 * like an attack from GitHub's side.
 */
const CONCURRENCY = 8;

export interface RepoFacts {
  owner: string;
  repo: string;
  fullName: string;
  defaultBranch: string;
  description: string | null;
  license: string | null;
  ownerUrl: string;
  htmlUrl: string;
  archived: boolean;
  stars: number;
}

function ghHeaders(): HeadersInit {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    // GitHub asks for this and will otherwise sometimes answer 403 with no
    // useful body, which is a miserable thing to debug from a log line.
    "User-Agent": "vibeverse-portal",
  };
  // Optional. Unauthenticated is 60 requests an hour per IP, which is fine for
  // a submission form and not fine for a busy one; setting GITHUB_TOKEN in the
  // function's secrets raises it to 5000 without any other change.
  const token = Deno.env.get("GITHUB_TOKEN");
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/** Turn a 4xx from GitHub into something a submitter can act on. */
async function ghFail(res: Response, what: string): Promise<never> {
  if (res.status === 404) {
    throw new Error(
      `Could not find ${what}. If the repository is private, the portal cannot reach it — ` +
        `make it public, or deploy the game and paste the deployed link instead.`,
    );
  }
  if (res.status === 403 || res.status === 429) {
    throw new Error(
      "GitHub is rate-limiting us right now. Try again in a few minutes — nothing is wrong with your repo.",
    );
  }
  const body = await res.text().catch(() => "");
  throw new Error(`GitHub said ${res.status} for ${what}. ${body.slice(0, 160)}`);
}

export async function fetchRepo(owner: string, repo: string): Promise<RepoFacts> {
  const res = await fetch(`${API}/repos/${enc(owner)}/${enc(repo)}`, { headers: ghHeaders() });
  if (!res.ok) await ghFail(res, `github.com/${owner}/${repo}`);
  const j = await res.json();
  return {
    owner: j.owner?.login ?? owner,
    repo: j.name ?? repo,
    fullName: j.full_name ?? `${owner}/${repo}`,
    defaultBranch: j.default_branch ?? "main",
    description: j.description ?? null,
    license: j.license?.spdx_id ?? null,
    ownerUrl: j.owner?.html_url ?? `https://github.com/${owner}`,
    htmlUrl: j.html_url ?? `https://github.com/${owner}/${repo}`,
    archived: !!j.archived,
    stars: Number(j.stargazers_count ?? 0),
  };
}

/** The commit a branch points at right now. This is what gets pinned. */
export async function fetchSha(owner: string, repo: string, ref: string): Promise<string> {
  const res = await fetch(`${API}/repos/${enc(owner)}/${enc(repo)}/commits/${enc(ref)}`, {
    headers: { ...ghHeaders(), Accept: "application/vnd.github.sha" },
  });
  if (!res.ok) await ghFail(res, `branch ${ref}`);
  const sha = (await res.text()).trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`GitHub returned an odd commit id for ${ref}`);
  return sha;
}

export async function fetchTree(owner: string, repo: string, sha: string): Promise<TreeEntry[]> {
  const res = await fetch(
    `${API}/repos/${enc(owner)}/${enc(repo)}/git/trees/${sha}?recursive=1`,
    { headers: ghHeaders() },
  );
  if (!res.ok) await ghFail(res, `the file list for ${owner}/${repo}`);
  const j = await res.json();
  if (j.truncated) {
    // GitHub stops at ~100k entries. A game is not in there.
    throw new Error(
      "That repository has too many files for GitHub to list in one go. " +
        "Deploy the game and paste the deployed link instead.",
    );
  }
  return (j.tree ?? []) as TreeEntry[];
}

export interface ResolvedRepo {
  facts: RepoFacts;
  ref: string;
  sha: string;
  plan: MirrorPlan;
  entryHtml: string;
  audit: ReturnType<typeof auditEntry>;
}

/**
 * Everything we need to decide, before anything is copied.
 *
 * The entry page is fetched here rather than during the copy because it is the
 * one file whose *contents* change the answer: it is what tells us the repo
 * holds source rather than a built site, and refusing at that point costs one
 * extra request instead of four hundred wasted uploads.
 */
export async function resolveRepo(
  owner: string,
  repo: string,
  wantedRef?: string,
): Promise<ResolvedRepo> {
  const facts = await fetchRepo(owner, repo);
  const ref = wantedRef || facts.defaultBranch;
  const sha = await fetchSha(facts.owner, facts.repo, ref);
  const tree = await fetchTree(facts.owner, facts.repo, sha);

  const entryPath = pickEntry(tree.filter((n) => n.type === "blob").map((n) => n.path));
  if (!entryPath) {
    throw new Error(
      "There is no HTML page in that repository, so there is nothing a browser can open. " +
        "If the game needs building, deploy it and paste the deployed link instead.",
    );
  }

  const plan = planMirror(tree, entryPath);
  if (plan.error) throw new Error(plan.error);

  const entryHtml = await fetchRaw(facts.owner, facts.repo, sha, entryPath).then((b) =>
    new TextDecoder().decode(b)
  );
  const audit = auditEntry(entryHtml, plan.files.map((f) => f.rel));

  return { facts, ref, sha, plan, entryHtml, audit };
}

async function fetchRaw(
  owner: string,
  repo: string,
  sha: string,
  path: string,
): Promise<ArrayBuffer> {
  const url = `${RAW}/${enc(owner)}/${enc(repo)}/${sha}/${path.split("/").map(enc).join("/")}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`could not read ${path} (${res.status})`);
  return await res.arrayBuffer();
}

export interface MirrorResult {
  prefix: string;
  uploaded: number;
  bytes: number;
  failed: { path: string; why: string }[];
}

/**
 * Copy the planned files into `portal-games/<slug>/<sha>/`.
 *
 * Keyed by commit, so a resync writes a fresh tree rather than overwriting a
 * live one file at a time. That matters more than it sounds: overwriting in
 * place means a player mid-game is served half the old build and half the new
 * one, and the resulting bug report is unreadable. A new prefix is atomic from
 * the player's point of view — nothing changes until the row's `embed_url`
 * moves, and that is one statement.
 */
export async function mirrorFiles(
  storage: {
    upload: (
      path: string,
      body: ArrayBuffer,
      opts: { contentType: string; upsert: boolean },
    ) => Promise<{ error: { message: string } | null }>;
  },
  owner: string,
  repo: string,
  sha: string,
  slug: string,
  plan: MirrorPlan,
): Promise<MirrorResult> {
  const prefix = `${slug}/${sha}`;
  const result: MirrorResult = { prefix, uploaded: 0, bytes: 0, failed: [] };

  const queue = [...plan.files];
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (;;) {
      const file = queue.shift();
      if (!file) return;
      try {
        const body = await fetchRaw(owner, repo, sha, file.path);
        // The size in the tree is what we planned against; a file that grew
        // between the plan and the copy would slip past the cap otherwise.
        if (body.byteLength > file.size + 1024) {
          result.failed.push({ path: file.rel, why: "file changed while copying" });
          continue;
        }
        const { error } = await storage.upload(`${prefix}/${file.rel}`, body, {
          contentType: file.contentType,
          upsert: true,
        });
        if (error) {
          result.failed.push({ path: file.rel, why: error.message });
          continue;
        }
        result.uploaded++;
        result.bytes += body.byteLength;
      } catch (e) {
        result.failed.push({ path: file.rel, why: String((e as Error).message ?? e) });
      }
    }
  });

  await Promise.all(workers);
  return result;
}

function enc(s: string): string {
  return encodeURIComponent(s);
}
