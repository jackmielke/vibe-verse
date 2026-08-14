/**
 * Every package that draws with three has an opinion about which three.
 *
 * This repo pins `three` at 0.160 and has done for a long time — forty-odd
 * worlds import it directly, and moving it is a day of work in every one of
 * them. Everything *around* three is on a caret range, so those float, and one
 * of them eventually floats past the pin.
 *
 * `postprocessing` did exactly that. Declared `^6.35.0`, resolved to 6.39.2,
 * and 6.39 is the release that raised its floor to `three >= 0.168`. The
 * consequences were split in a way that hid it for a while:
 *
 *   - `npm ci` and `npm install` refused to run at all — ERESOLVE, no
 *     node_modules, so `npm run typecheck`, `npm run build`, `npm test` and
 *     `npm run smoke` were *all* unavailable on a fresh clone. Every check
 *     CLAUDE.md tells you to run before pushing to a live `main`.
 *   - bun does not enforce peer ranges, so the deploy path installed it
 *     happily and nothing went red. The build was green the whole time.
 *
 * That is the shape to guard against: a mismatch npm treats as fatal and bun
 * treats as fine. A test is the right net precisely because the bun path is
 * the one that ships — if npm is what you ran, you already know, and if bun is
 * what you ran, this is the only thing that will tell you.
 *
 * It reads the installed tree rather than the lockfile on purpose. The
 * lockfile says what *should* be there; node_modules is what the renderer will
 * actually import.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import semver from "semver";

const MODULES = path.resolve(__dirname, "../../node_modules");

function readManifest(dir: string): Record<string, unknown> | null {
  const file = path.join(dir, "package.json");
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Top-level installed packages that declare a peer range on `three`.
 *
 * Only the hoisted tree: a nested copy has its own three next to it and is
 * not the one our imports resolve to.
 */
function peersOnThree(): Array<{ name: string; version: string; range: string }> {
  const found: Array<{ name: string; version: string; range: string }> = [];

  const visit = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry.startsWith(".")) continue;
      const full = path.join(dir, entry);
      if (entry.startsWith("@")) {
        visit(full, `${entry}/`);
        continue;
      }
      const manifest = readManifest(full);
      const peers = manifest?.peerDependencies as Record<string, string> | undefined;
      const range = peers?.three;
      if (range) {
        found.push({ name: prefix + entry, version: String(manifest?.version), range });
      }
    }
  };

  visit(MODULES, "");
  return found;
}

describe("three's peers", () => {
  const installed = readManifest(path.join(MODULES, "three"));
  const three = String(installed?.version ?? "");

  it("has three installed at the version the root pins", () => {
    const root = JSON.parse(
      readFileSync(path.resolve(__dirname, "../../package.json"), "utf8"),
    );
    const declared = root.dependencies.three as string;
    expect(semver.valid(three), `three@${three} is not a version`).toBeTruthy();
    expect(
      semver.satisfies(three, declared),
      `package.json asks for three@${declared}, node_modules has ${three}`,
    ).toBe(true);
  });

  it("installs nothing that wants a different three", () => {
    const unhappy = peersOnThree()
      .filter(({ range }) => range !== "*" && !semver.satisfies(three, range))
      .map(({ name, version, range }) => `${name}@${version} wants three ${range}`);

    expect(
      unhappy,
      [
        `three is pinned at ${three} and these disagree:`,
        ...unhappy.map((line) => `  - ${line}`),
        "",
        "npm will refuse to install this tree; bun will install it without",
        "complaining. Pin the offender below its breaking release rather than",
        "widening the range — moving three is a change to forty worlds.",
      ].join("\n"),
    ).toEqual([]);
  });
});
