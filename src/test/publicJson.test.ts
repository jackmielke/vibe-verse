/**
 * Everything we publish as JSON under `public/` has to parse.
 *
 * `public/build-log.json` is served at myvibeverse.com/build-log.json, and it
 * shipped for weeks with `<<<<<<< HEAD` in it — a merge conflict committed
 * whole. Nothing caught it because nothing in the app reads the file: it is a
 * public endpoint, so the only consumer is somebody else's fetch, and the one
 * generator that could have overwritten it deliberately keeps the committed
 * copy on a shallow clone. Every deploy is a shallow clone.
 *
 * A parse is the entire test. It is cheap, it needs no knowledge of any of
 * these files' schemas, and it is exactly the assertion the corrupt file
 * failed.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const PUBLIC = join(process.cwd(), "public");

function jsonFiles(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    // Somebody else's game, mirrored or vendored, is not ours to police.
    if (name === "games" || name === "node_modules") continue;
    if (statSync(full).isDirectory()) jsonFiles(full, acc);
    else if (name.endsWith(".json")) acc.push(full);
  }
  return acc;
}

describe("published JSON", () => {
  it("parses", () => {
    const files = jsonFiles(PUBLIC);
    expect(files.length, "no JSON found under public/ — has it moved?").toBeGreaterThan(0);
    for (const file of files) {
      const rel = file.slice(PUBLIC.length + 1);
      const raw = readFileSync(file, "utf8");
      /* Named explicitly, because "Unexpected token <" is a baffling way to
         be told that a merge went in sideways.
         Anchored to the start of a line, because git writes it there and a
         JSON string value cannot be: the build log has an entry *about* this
         bug, quoting the marker, and matching it anywhere in the file failed
         the honest file for describing the broken one. */
      expect(/^<{7}( |$)/m.test(raw), `public/${rel} has merge conflict markers`).toBe(false);
      expect(() => JSON.parse(raw), `public/${rel} is not valid JSON`).not.toThrow();
    }
  });
});
