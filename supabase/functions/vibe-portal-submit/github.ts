/**
 * Reading a link somebody pasted.
 *
 * Everything in this file is a pure function of its arguments — no network, no
 * database, no Deno globals — because this is the part that decides what gets
 * copied onto our storage and framed in front of a player, and that decision
 * should be testable without a Supabase project. `src/test/portalSubmit.test.ts`
 * imports this module directly and runs it against the real shape of a real
 * repository.
 *
 * The one idea worth holding on to while reading:
 *
 *     We are not "supporting GitHub". We are answering one question —
 *     *is there a folder of files in here that a browser can open?* — and
 *     saying so plainly when the answer is no.
 *
 * Most repositories that fail do so for a single reason: the game is written in
 * something that has to be built, and the repository holds the source rather
 * than the result. A browser cannot run `main.tsx`. Detecting that and saying
 * "deploy it and paste the deployed link instead" is worth more than any amount
 * of cleverness, because it turns a blank rectangle into a next step.
 */

// ---------------------------------------------------------------------------
// What we are willing to copy
// ---------------------------------------------------------------------------

/**
 * Extension → content type.
 *
 * An allowlist rather than a blocklist, and a content type we choose rather
 * than one we inherit. Both halves matter:
 *
 *   * allowlist, because the interesting question is not "is `.exe` dangerous"
 *     but "what does a browser do with a file type I did not think about". The
 *     answer for anything absent from this table is: it is not copied.
 *   * our own content type, because this is the whole reason the mirror exists.
 *     `raw.githubusercontent.com` serves every file as `text/plain`, which is
 *     why you cannot simply frame a repository — the browser shows the player
 *     the source code of the game instead of the game.
 *
 * Worth naming rather than glossing: `.svg` is on the list, and an SVG can
 * carry script. That is not a hole so much as a restatement of where we already
 * are — the mirror origin holds nothing of ours (see the migration), and we are
 * already serving the game's own `.js` from it. An SVG buys an attacker
 * precisely nothing the `.js` did not. Listing it and saying why beats leaving
 * it off and letting the next person wonder whether it was an oversight.
 */
export const CONTENT_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  xml: "application/xml; charset=utf-8",
  wasm: "application/wasm",
  map: "application/json; charset=utf-8",

  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  cur: "image/x-icon",
  bmp: "image/bmp",

  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  flac: "audio/flac",
  mp4: "video/mp4",
  webm: "video/webm",

  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  eot: "application/vnd.ms-fontobject",

  glb: "model/gltf-binary",
  gltf: "model/gltf+json",
  obj: "text/plain; charset=utf-8",
  mtl: "text/plain; charset=utf-8",
  fbx: "application/octet-stream",
  bin: "application/octet-stream",
  atlas: "text/plain; charset=utf-8",
  fnt: "text/plain; charset=utf-8",
  pck: "application/octet-stream",
};

/**
 * The caps.
 *
 * These are not security boundaries — the extension allowlist and the sandbox
 * are — they are a bound on what one submission can cost us in storage and in
 * edge-function seconds. A game that does not fit is not rejected as bad; it is
 * told it is too big to mirror and pointed at the hosted door, which has no
 * size limit at all because it costs us nothing.
 */
export const CAPS = {
  /** Files copied. 2048 is 34; a chunky Godot export is a few hundred. */
  files: 400,
  /** One file. Matches `file_size_limit` on the bucket, deliberately. */
  fileBytes: 8 * 1024 * 1024,
  /** Everything, together. */
  totalBytes: 48 * 1024 * 1024,
  /** Path length, because storage keys are not unbounded either. */
  pathLength: 300,
};

/** Directories that are never part of a game, however the repo is laid out. */
const SKIP_DIRS = new Set([
  ".git",
  ".github",
  ".vscode",
  ".idea",
  "node_modules",
  "__pycache__",
  ".next",
  ".cache",
]);

// ---------------------------------------------------------------------------
// Reading the pasted link
// ---------------------------------------------------------------------------

export interface GitHubTarget {
  kind: "github";
  owner: string;
  repo: string;
  /** A branch, if they pasted a `/tree/<branch>` URL. Otherwise the default. */
  ref?: string;
}

export interface HostedTarget {
  kind: "hosted";
  /** The URL we will frame, normalised. */
  embedUrl: string;
  /** The single origin permitted to talk to us. */
  origin: string;
}

export type Target = GitHubTarget | HostedTarget;

/**
 * One field, two doors.
 *
 * The classification is by host rather than by asking the submitter, because
 * "is this a repository or a website" is a question we can answer perfectly and
 * they can get wrong. A `github.io` URL is deliberately *hosted*, not github —
 * it is already a served website, and mirroring it would be copying something
 * that does not need copying.
 */
export function parseSubmission(raw: string): { target?: Target; error?: string } {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return { error: "Paste a link first." };

  // A bare `owner/repo` is what people type when they are thinking about
  // GitHub rather than about URLs, and refusing it would be pedantry.
  const bare = /^([A-Za-z0-9][\w.-]*)\/([\w.-]+)$/.exec(trimmed);
  if (bare) return { target: { kind: "github", owner: bare[1], repo: stripGit(bare[2]) } };

  let url: URL;
  try {
    url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
  } catch {
    return { error: "That does not look like a link." };
  }

  if (url.protocol !== "https:") {
    // Not pedantry: a browser refuses to frame http content inside an https
    // page, so an http submission is a guaranteed blank rectangle later.
    return { error: "Links have to be https — a browser will not put an http page inside ours." };
  }

  const host = url.hostname.toLowerCase();

  if (host === "github.com" || host === "www.github.com") {
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 2) {
      return { error: "That is a GitHub link, but not to a repository." };
    }
    const [owner, repoRaw, ...rest] = parts;
    // `/tree/<branch>` and `/blob/<branch>/…` both name a branch, and somebody
    // pasting from their browser's address bar is usually on one.
    let ref: string | undefined;
    if ((rest[0] === "tree" || rest[0] === "blob") && rest[1]) ref = rest[1];
    return { target: { kind: "github", owner, repo: stripGit(repoRaw), ref } };
  }

  if (host === "gist.github.com") {
    return { error: "Gists cannot be mirrored — put the game in a repository and paste that." };
  }

  // Anything else is a website. We frame it where it stands.
  return {
    target: {
      kind: "hosted",
      embedUrl: url.toString(),
      origin: url.origin,
    },
  };
}

function stripGit(s: string): string {
  return s.replace(/\.git$/i, "");
}

// ---------------------------------------------------------------------------
// Slugs
// ---------------------------------------------------------------------------

/**
 * A route from a repository name.
 *
 * The result has to satisfy the check constraint on `vibe_portal_games.slug`
 * (`^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$`), which is stricter than it looks: at
 * least three characters, no leading or trailing dash, nothing else. Rather
 * than trusting that a cleaned-up name lands inside it, this pads and trims
 * until it does, and the test asserts the constraint on a pile of hostile
 * names — because the failure mode otherwise is a database error in front of
 * somebody who just wanted to share a game.
 */
export function slugify(name: string, taken: Iterable<string> = []): string {
  let base = String(name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (base.length < 3) base = `${base || "game"}-game`.replace(/^-+/, "");
  if (base.length > 34) base = base.slice(0, 34).replace(/-+$/, "");
  if (base.length < 3) base = "game";

  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; n < 500; n++) {
    const candidate = `${base.slice(0, 34 - String(n).length - 1)}-${n}`.replace(/-+/g, "-");
    if (!used.has(candidate)) return candidate;
  }
  throw new Error("could not find a free slug");
}

/** The constraint from the migration, so tests and callers agree on it. */
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * Is this path safe to use as a storage key?
 *
 * Path traversal against object storage is not the same bug as against a
 * filesystem — there is no parent directory to escape into — but a `..` segment
 * still lets one submission write over another submission's prefix, which is
 * the same bug wearing a different hat. Everything questionable is refused
 * rather than normalised: a repository containing `../` in a filename is not a
 * case worth supporting.
 */
export function safeRelPath(p: string): boolean {
  if (!p || p.length > CAPS.pathLength) return false;
  if (p.startsWith("/") || p.includes("\\")) return false;
  // Control characters, including the NUL that truncates a key.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(p)) return false;
  const segments = p.split("/");
  for (const s of segments) {
    if (!s || s === "." || s === "..") return false;
    if (SKIP_DIRS.has(s)) return false;
  }
  return true;
}

export function extensionOf(p: string): string {
  const base = p.slice(p.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot + 1).toLowerCase();
}

export function contentTypeFor(p: string): string | null {
  return CONTENT_TYPES[extensionOf(p)] ?? null;
}

// ---------------------------------------------------------------------------
// Finding the front door
// ---------------------------------------------------------------------------

/**
 * Where a repository keeps the page a browser should open.
 *
 * Ordered by how strongly the location signals intent rather than by how
 * common it is. A root `index.html` is the game. `docs/` and `public/` are
 * where somebody who has already published the thing keeps it. `dist/` and
 * `build/` are outputs somebody committed on purpose — unusual, and when it
 * happens it is exactly because they wanted it servable.
 *
 * `src/index.html` is last and is nearly always a trap: it is the Vite
 * template, and it loads `/src/main.tsx`, which no browser can run. It is
 * still checked, because being wrong here produces a clear "this needs a build
 * step" message from `auditEntry` rather than silence.
 */
const ENTRY_DIRS = ["", "docs", "public", "dist", "build", "www", "site", "game", "web", "src"];

export function pickEntry(paths: string[]): string | null {
  const set = new Set(paths);
  for (const dir of ENTRY_DIRS) {
    const candidate = dir ? `${dir}/index.html` : "index.html";
    if (set.has(candidate)) return candidate;
  }
  // Nothing named `index.html` anywhere expected. Take the shallowest one that
  // exists, and failing that the shallowest `.html` of any name — a jam game
  // called `game.html` is still a game.
  const htmls = paths
    .filter((p) => /\.html?$/i.test(p))
    .sort((a, b) => depth(a) - depth(b) || a.length - b.length || a.localeCompare(b));
  const index = htmls.find((p) => /(^|\/)index\.html?$/i.test(p));
  return index ?? htmls[0] ?? null;
}

function depth(p: string): number {
  return p.split("/").length;
}

// ---------------------------------------------------------------------------
// Planning the copy
// ---------------------------------------------------------------------------

export interface TreeEntry {
  path: string;
  /** GitHub's tree API calls files `blob`. */
  type: string;
  size?: number;
}

export interface PlannedFile {
  /** Path in the repository. */
  path: string;
  /** Path relative to the mirror root — what the browser will ask for. */
  rel: string;
  size: number;
  contentType: string;
}

export interface MirrorPlan {
  /** Directory in the repo that becomes the web root, "" for the repo root. */
  root: string;
  /** The entry, relative to `root`. Nearly always `index.html`. */
  entry: string;
  files: PlannedFile[];
  totalBytes: number;
  /** Paths left behind, with why. Reported, never silently dropped. */
  skipped: { path: string; why: string }[];
  error?: string;
}

/**
 * Decide exactly which bytes get copied, before copying any of them.
 *
 * Two things here are load-bearing and not obvious:
 *
 * **The mirror is rooted at the entry's directory, not at the repository
 * root.** A repo with `docs/index.html` referencing `js/game.js` means
 * `docs/js/game.js`, and if we copied from the repository root the game would
 * have to be served at `/docs/index.html` with every relative path one level
 * off. Re-rooting makes relative paths work unchanged, which is the difference
 * between a game that runs and a game that 404s in eleven places.
 *
 * **Everything outside that root is skipped, including the README.** Not to be
 * tidy: it is somebody else's repository and copying no more of it than the
 * game needs is the polite version of mirroring.
 */
export function planMirror(tree: TreeEntry[], entryPath: string): MirrorPlan {
  const root = entryPath.includes("/") ? entryPath.slice(0, entryPath.lastIndexOf("/")) : "";
  const prefix = root ? `${root}/` : "";
  const plan: MirrorPlan = {
    root,
    entry: entryPath.slice(prefix.length),
    files: [],
    totalBytes: 0,
    skipped: [],
  };

  for (const node of tree) {
    if (node.type !== "blob") continue;
    const path = node.path;
    if (prefix && !path.startsWith(prefix)) continue;
    const rel = path.slice(prefix.length);
    if (!rel) continue;

    if (!safeRelPath(rel)) {
      plan.skipped.push({ path, why: "unsafe path" });
      continue;
    }
    const contentType = contentTypeFor(rel);
    if (!contentType) {
      plan.skipped.push({ path, why: `no rule for .${extensionOf(rel) || "(none)"}` });
      continue;
    }
    const size = Number(node.size ?? 0);
    if (size > CAPS.fileBytes) {
      plan.skipped.push({ path, why: `${mb(size)} is over the ${mb(CAPS.fileBytes)} file cap` });
      continue;
    }

    plan.files.push({ path, rel, size, contentType });
    plan.totalBytes += size;
  }

  // Sort so the entry lands first. It is the file most likely to reveal a
  // problem, and finding out on file 1 rather than file 340 is worth the sort.
  plan.files.sort((a, b) =>
    a.rel === plan.entry ? -1 : b.rel === plan.entry ? 1 : a.rel.localeCompare(b.rel),
  );

  if (!plan.files.some((f) => f.rel === plan.entry)) {
    plan.error = `Found ${entryPath}, but could not copy it.`;
  } else if (plan.files.length > CAPS.files) {
    plan.error =
      `That repository has ${plan.files.length} files to copy and the limit is ${CAPS.files}. ` +
      `Deploy it somewhere and paste the deployed link instead — hosted games have no size limit.`;
  } else if (plan.totalBytes > CAPS.totalBytes) {
    plan.error =
      `That repository is ${mb(plan.totalBytes)} of copyable files and the limit is ${mb(CAPS.totalBytes)}. ` +
      `Deploy it somewhere and paste the deployed link instead — hosted games have no size limit.`;
  }

  return plan;
}

function mb(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

// ---------------------------------------------------------------------------
// Will it actually run?
// ---------------------------------------------------------------------------

export interface EntryAudit {
  ok: boolean;
  /** Local files the page asks for that are not in the plan. */
  missing: string[];
  /** The page loads TypeScript or JSX: it is source, not a built site. */
  needsBuild: boolean;
  /** Any HTML references vibeverse.js, so the game can pay. */
  usesSdk: boolean;
  /** Written for the submitter, not for us. */
  note?: string;
}

/**
 * Read the entry page and decide whether framing it would be honest.
 *
 * This is the check that earns the whole "paste a link and it works" promise,
 * because without it the failure mode is a black rectangle and a shrug. It is
 * deliberately a regex over the HTML rather than a parse: we are looking for
 * three specific things, none of which need a DOM, and a dependency-free pure
 * function is worth more here than perfect coverage of exotic markup.
 *
 * The `needsBuild` case is the common one and deserves its own message. A
 * Lovable, Vite or CRA repository has an `index.html` that loads
 * `/src/main.tsx`. Those repos are not broken and their authors are not doing
 * anything wrong — the built site simply lives at their deploy URL rather than
 * in the repository, and the right advice is to paste *that*.
 */
export function auditEntry(html: string, relPaths: Iterable<string>): EntryAudit {
  const have = new Set(relPaths);
  const audit: EntryAudit = { ok: true, missing: [], needsBuild: false, usesSdk: false };

  const refs: string[] = [];
  const attr = /<(?:script|link|img|source|audio|video)\b[^>]*?\b(?:src|href)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  for (let m = attr.exec(html); m; m = attr.exec(html)) {
    refs.push((m[2] ?? m[3] ?? m[4] ?? "").trim());
  }

  for (const ref of refs) {
    if (!ref) continue;
    if (/^(https?:)?\/\//i.test(ref) || /^(data|blob|mailto|#|javascript):/i.test(ref)) {
      if (/vibeverse\.js(\?|$)/i.test(ref)) audit.usesSdk = true;
      continue;
    }
    if (/vibeverse\.js(\?|$)/i.test(ref)) audit.usesSdk = true;

    const clean = ref.split(/[?#]/)[0];
    if (!clean) continue;
    if (/\.(tsx?|jsx)$/i.test(clean)) audit.needsBuild = true;

    // A leading slash means the site root. Mirrored games are served from a
    // prefixed key, so a root-absolute path escapes the mirror and will 404 —
    // treat it as missing, because for this game it is.
    const rel = clean.replace(/^\.\//, "");
    if (rel.startsWith("/")) {
      audit.missing.push(clean);
      continue;
    }
    if (!have.has(rel)) audit.missing.push(clean);
  }

  if (/vibeverse\.js/i.test(html)) audit.usesSdk = true;

  const missingScripts = audit.missing.filter((p) => /\.(m?js|tsx?|jsx)$/i.test(p));

  if (audit.needsBuild) {
    audit.ok = false;
    audit.note =
      "That repository holds the source, not the built site — its page loads a TypeScript or JSX " +
      "file, which a browser cannot run. Deploy it (Lovable, Vercel, Netlify, GitHub Pages all " +
      "work) and paste the deployed link instead: hosted games skip the copy entirely.";
  } else if (missingScripts.length) {
    audit.ok = false;
    audit.note =
      `The page loads ${missingScripts.slice(0, 3).join(", ")}` +
      `${missingScripts.length > 3 ? ` and ${missingScripts.length - 3} more` : ""}, ` +
      "which is not in the repository. If those files are produced by a build step, deploy the " +
      "game and paste the deployed link instead.";
  } else if (audit.missing.length) {
    // Missing images and stylesheets are cosmetic. Say so and carry on: a game
    // with a broken favicon is still a game, and refusing it would be silly.
    audit.note =
      `Mirrored, but ${audit.missing.length} referenced file` +
      `${audit.missing.length === 1 ? "" : "s"} could not be found ` +
      `(${audit.missing.slice(0, 3).join(", ")}). The game should still run.`;
  }

  return audit;
}
