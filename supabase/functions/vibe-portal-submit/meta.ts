/**
 * Reading a page's own description of itself.
 *
 * A deployed game gets framed where it stands, and until now that meant we knew
 * almost nothing about it: the title was the hostname with its first letter
 * capitalised, the tagline was `null`, and there was no picture at all. So the
 * card for somebody's game said "Leo" and nothing else, and the submitter — who
 * had written a perfectly good `<title>` and an og:image — had to watch us
 * ignore both.
 *
 * Every page that has ever been shared on a chat app already carries this
 * metadata. We just have to read it.
 *
 * Pure functions of a string, like `github.ts` next door and for the same
 * reason: this parses bytes from a stranger's server, which is exactly the code
 * that should be testable without a Supabase project. The fetching lives in
 * `index.ts`; nothing here touches the network.
 *
 * ## Deliberately a regex parser, not a DOM
 *
 * Deno has no DOM, and pulling in a parser to read four `<meta>` tags out of a
 * document we do not control is more attack surface than the job needs. The
 * rule is the same one `auditEntry` follows: **a wrong answer must be a missing
 * answer, never a confident wrong one.** Every field here is optional and every
 * caller has a fallback, so a page whose markup defeats these patterns loses a
 * picture — it does not break a submission.
 */

/** What a page says about itself. Every field is best-effort. */
export interface PageMeta {
  title: string | null;
  description: string | null;
  /** Absolute URL, resolved against the page it was found on. */
  image: string | null;
  /** og:site_name, which is often the studio rather than the game. */
  siteName: string | null;
}

/** Longest a value we will keep — a tagline, not an essay. */
export const META_CAPS = { title: 120, description: 300, image: 2048 } as const;

/**
 * Decode the handful of HTML entities that actually turn up in titles.
 *
 * Not a general entity decoder: an incomplete list that is obviously incomplete
 * beats a clever one that mis-decodes something. `&amp;` is the one that
 * matters — "Cat &amp; Mouse" is a real title and the raw form looks broken.
 */
function decodeEntities(s: string): string {
  return s
    .replace(/&(#39|apos|lsquo|rsquo);/g, "'")
    .replace(/&(#34|quot|ldquo|rdquo);/g, '"')
    .replace(/&(#8211|ndash);/g, "–")
    .replace(/&(#8212|mdash);/g, "—")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    /* Last, always. Decoding it first would turn `&amp;lt;` into `<`, which is
       how an entity decoder becomes an injection bug. */
    .replace(/&amp;/g, "&");
}

/** Collapse whitespace and trim to a cap. Empty becomes null. */
function clean(v: string | null | undefined, cap: number): string | null {
  if (!v) return null;
  const s = decodeEntities(v).replace(/\s+/g, " ").trim();
  if (!s) return null;
  return s.length > cap ? `${s.slice(0, cap - 1).trimEnd()}…` : s;
}

/**
 * Find one `<meta>` value.
 *
 * Matches `property=` and `name=` in either order relative to `content=`,
 * because both orderings are common and half the pages in the world use `name`
 * for OpenGraph even though the spec says `property`.
 */
function metaContent(html: string, key: string): string | null {
  const k = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const attr = `(?:property|name)\\s*=\\s*["']${k}["']`;
  const content = `content\\s*=\\s*["']([^"']*)["']`;
  const before = new RegExp(`<meta[^>]*${attr}[^>]*${content}[^>]*>`, "i");
  const after = new RegExp(`<meta[^>]*${content}[^>]*${attr}[^>]*>`, "i");
  return before.exec(html)?.[1] ?? after.exec(html)?.[1] ?? null;
}

/**
 * Resolve a possibly-relative URL against the page it appeared on.
 *
 * og:image is relative more often than anybody expects. Returns null rather
 * than a guess for anything that is not http(s) once resolved — a `javascript:`
 * or `data:` image URL is not something to put in a database and render later.
 */
export function resolveUrl(base: string, href: string | null): string | null {
  if (!href) return null;
  try {
    const u = new URL(href, base);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Read what a page says about itself.
 *
 * Preference order is OpenGraph, then Twitter's copy of it, then the plain
 * HTML. That is the order of how deliberate each one is: og:title was written
 * for a card exactly like ours, while `<title>` is often "Vite + React + TS".
 */
export function parsePageMeta(html: string, pageUrl: string): PageMeta {
  /* Only the head, and only the first 256 KB of it. A game's index.html can
     carry a megabyte of inlined bundle, and scanning it for four tags is work
     that finds nothing — the tags we want are legally required to be in
     `<head>` and are in practice in its first few lines. */
  const headEnd = html.search(/<\/head>/i);
  const head = html.slice(0, headEnd > 0 ? headEnd : Math.min(html.length, 262_144));

  const docTitle = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1] ?? null;

  const title =
    clean(metaContent(head, "og:title"), META_CAPS.title) ??
    clean(metaContent(head, "twitter:title"), META_CAPS.title) ??
    clean(docTitle, META_CAPS.title);

  const description =
    clean(metaContent(head, "og:description"), META_CAPS.description) ??
    clean(metaContent(head, "twitter:description"), META_CAPS.description) ??
    clean(metaContent(head, "description"), META_CAPS.description);

  const rawImage =
    metaContent(head, "og:image") ??
    metaContent(head, "og:image:url") ??
    metaContent(head, "twitter:image") ??
    metaContent(head, "twitter:image:src");

  return {
    title,
    description,
    image: resolveUrl(pageUrl, clean(rawImage, META_CAPS.image)),
    siteName: clean(metaContent(head, "og:site_name"), META_CAPS.title),
  };
}

/**
 * GitHub draws a card for every repository, so a repo always has a cover.
 *
 * It is generated from the repo's own name, description, owner avatar and
 * language — which is a better picture of a codebase than anything we could
 * synthesise, and it stays right when they rename things.
 */
export function githubCover(fullName: string): string | null {
  return /^[\w.-]+\/[\w.-]+$/.test(fullName)
    ? `https://opengraph.githubassets.com/1/${fullName}`
    : null;
}

/**
 * A title worth showing, given everything we found.
 *
 * The fallback chain ends at the hostname because that is what the column used
 * to hold unconditionally, and it is a reasonable last resort — but it is now
 * genuinely last, rather than first and only.
 */
export function bestTitle(meta: PageMeta, hostFallback: string): string {
  /* A site name is the studio, not the game — "itch.io" is not a title. It is
     only used when the page gave us nothing better, and even then the hostname
     usually says the same thing. */
  return meta.title ?? hostFallback;
}
