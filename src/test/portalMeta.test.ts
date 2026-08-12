/**
 * Reading a stranger's page, tested against the markup strangers actually write.
 *
 * `meta.ts` parses HTML we did not author, served from a host we do not
 * control, and the result gets stored and rendered on a card. That is the same
 * category of code as `github.ts` next door, and it gets the same treatment:
 * pure functions, tested here, no Supabase project required.
 *
 * The governing rule, and what most of these assert: **a wrong answer must be a
 * missing answer.** Every field is optional and every caller has a fallback, so
 * the failure mode of a page these patterns cannot read is a missing picture —
 * never a confident wrong one, and never a `javascript:` URL in a database.
 */
import { describe, expect, it } from "vitest";

import {
  META_CAPS,
  bestTitle,
  githubCover,
  parsePageMeta,
  resolveUrl,
} from "../../supabase/functions/vibe-portal-submit/meta";

/** The shape a Vite/Lovable build actually ships. */
const LOVABLE = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>Neon Drift — a tiny racing game</title>
    <meta name="description" content="Drift through a neon city. Three tracks, one button." />
    <meta property="og:title" content="Neon Drift" />
    <meta property="og:description" content="Drift through a neon city." />
    <meta property="og:image" content="https://neon-drift.lovable.app/cover.png" />
    <meta property="og:site_name" content="Lovable" />
    <script type="module" crossorigin src="/assets/index-abc.js"></script>
  </head>
  <body><div id="root"></div></body>
</html>`;

describe("parsePageMeta", () => {
  const meta = parsePageMeta(LOVABLE, "https://neon-drift.lovable.app/");

  it("prefers OpenGraph over the document title", () => {
    /* og:title was written for a card exactly like ours; <title> is often
       "Vite + React + TS" or carries a trailing tagline. */
    expect(meta.title).toBe("Neon Drift");
    expect(meta.description).toBe("Drift through a neon city.");
    expect(meta.image).toBe("https://neon-drift.lovable.app/cover.png");
    expect(meta.siteName).toBe("Lovable");
  });

  it("falls back to <title> and <meta name=description>", () => {
    const bare = `<html><head><title>  Tiny   Golf  </title>
      <meta name="description" content="Nine holes."></head><body></body></html>`;
    const m = parsePageMeta(bare, "https://x.example/");
    expect(m.title).toBe("Tiny Golf");
    expect(m.description).toBe("Nine holes.");
    expect(m.image).toBeNull();
  });

  it("accepts name= for OpenGraph, which half the web uses", () => {
    const m = parsePageMeta(
      `<head><meta name="og:title" content="Sideways"></head>`,
      "https://x.example/",
    );
    expect(m.title).toBe("Sideways");
  });

  it("accepts content= before the property attribute", () => {
    const m = parsePageMeta(
      `<head><meta content="Backwards" property="og:title"></head>`,
      "https://x.example/",
    );
    expect(m.title).toBe("Backwards");
  });

  it("resolves a relative og:image against the page", () => {
    const m = parsePageMeta(
      `<head><meta property="og:image" content="/img/cover.png"></head>`,
      "https://game.example/play/index.html",
    );
    expect(m.image).toBe("https://game.example/img/cover.png");
  });

  it("takes twitter:* when OpenGraph is absent", () => {
    const m = parsePageMeta(
      `<head><meta name="twitter:title" content="Bird"><meta name="twitter:image" content="https://a.example/b.png"></head>`,
      "https://a.example/",
    );
    expect(m.title).toBe("Bird");
    expect(m.image).toBe("https://a.example/b.png");
  });

  it("returns nulls rather than guesses for a page with no metadata", () => {
    const m = parsePageMeta("<html><body>hi</body></html>", "https://x.example/");
    expect(m).toEqual({ title: null, description: null, image: null, siteName: null });
  });

  it("decodes the entities that turn up in real titles", () => {
    const m = parsePageMeta(
      `<head><title>Cat &amp; Mouse &#8212; a game</title></head>`,
      "https://x.example/",
    );
    expect(m.title).toBe("Cat & Mouse — a game");
  });

  it("decodes &amp; last, so &amp;lt; does not become a tag", () => {
    /* Decoding `&amp;` first turns `&amp;lt;` into `&lt;` into `<`, which is
       the classic way an entity decoder becomes an injection bug. */
    const m = parsePageMeta(
      `<head><title>a &amp;lt;b&amp;gt; c</title></head>`,
      "https://x.example/",
    );
    expect(m.title).toBe("a &lt;b&gt; c");
  });

  it("caps a rambling description instead of storing an essay", () => {
    const long = "word ".repeat(400);
    const m = parsePageMeta(
      `<head><meta property="og:description" content="${long}"></head>`,
      "https://x.example/",
    );
    expect(m.description!.length).toBeLessThanOrEqual(META_CAPS.description);
    expect(m.description!.endsWith("…")).toBe(true);
  });

  it("ignores metadata below </head>", () => {
    /* A game's body can contain anything, including a string that looks like a
       meta tag. Only the head is authoritative. */
    const m = parsePageMeta(
      `<head><title>Real</title></head><body><meta property="og:title" content="Fake"></body>`,
      "https://x.example/",
    );
    expect(m.title).toBe("Real");
  });
});

describe("resolveUrl", () => {
  it("keeps http and https", () => {
    expect(resolveUrl("https://a.example/", "https://b.example/c.png")).toBe(
      "https://b.example/c.png",
    );
    expect(resolveUrl("https://a.example/", "http://b.example/c.png")).toBe(
      "http://b.example/c.png",
    );
  });

  it("refuses every other scheme", () => {
    /* This value ends up in a database and later in an `<img src>`. */
    for (const bad of [
      "javascript:alert(1)",
      "data:image/svg+xml,<svg onload=alert(1)>",
      "vbscript:msgbox",
      "file:///etc/passwd",
    ]) {
      expect(resolveUrl("https://a.example/", bad)).toBeNull();
    }
  });

  it("is null for null and for nonsense", () => {
    expect(resolveUrl("https://a.example/", null)).toBeNull();
    expect(resolveUrl("not a url", "also not")).toBeNull();
  });
});

describe("githubCover", () => {
  it("points at the card GitHub already draws", () => {
    expect(githubCover("gabrielecirulli/2048")).toBe(
      "https://opengraph.githubassets.com/1/gabrielecirulli/2048",
    );
  });

  it("refuses anything that is not owner/name", () => {
    /* The value is interpolated into a URL, so a slash or a space in here would
       be a path-traversal in a string. */
    for (const bad of ["../../etc", "owner/repo/extra", "owner only", "", "a/b?c=d"]) {
      expect(githubCover(bad)).toBeNull();
    }
  });
});

describe("bestTitle", () => {
  it("uses the page's title when there is one", () => {
    expect(bestTitle(parsePageMeta(LOVABLE, "https://x.example/"), "Neon-drift")).toBe(
      "Neon Drift",
    );
  });

  it("falls back to the hostname, which is what we used to always use", () => {
    const empty = parsePageMeta("<html></html>", "https://x.example/");
    expect(bestTitle(empty, "Neon-drift")).toBe("Neon-drift");
  });

  it("does not use og:site_name as a title", () => {
    /* "Lovable" and "itch.io" are studios, not games. */
    const m = parsePageMeta(
      `<head><meta property="og:site_name" content="itch.io"></head>`,
      "https://x.example/",
    );
    expect(bestTitle(m, "Coolgame")).toBe("Coolgame");
  });
});
