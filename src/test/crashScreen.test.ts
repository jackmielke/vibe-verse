/**
 * The crash screen has to be *legible to a machine*, not just to a person.
 *
 * `scripts/route-smoke.mjs` is the only automated check that opens a world and
 * asks whether it is there, and it passes a route the moment the page renders
 * any text. The friendly crash screen is text — so a route that threw on every
 * single visit rendered "A corner of the VibeVerse glitched" and the smoke test
 * reported `ok`. That is precisely the failure the smoke test exists to catch,
 * and it went out that way: /city crashed for every player whose saved
 * character had no GLB, and no check said a word.
 *
 * The fix is a `data-vibe-crash` attribute on the fallback's root, which the
 * smoke test looks for and scores as the worst verdict there is. Two files
 * have to agree on that string, and nothing else in a build or a typecheck
 * connects them, so the agreement is asserted here — the same trick
 * `arcade.test.ts` uses on the paytable it shares with an edge function.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { ErrorFallback } from "@/components/ErrorBoundary";

const MARKER = "data-vibe-crash";

function markup(error: Error | null) {
  return renderToStaticMarkup(createElement(ErrorFallback, { error }));
}

describe("the crash screen is machine-readable", () => {
  it("marks itself on every flavour of crash", () => {
    expect(markup(new Error("boom"))).toContain(`${MARKER}="render"`);
    expect(markup(new Error("Error creating WebGL context."))).toContain(`${MARKER}="webgl"`);
    expect(markup(new Error("Failed to fetch dynamically imported module: /assets/City-abc.js"))).toContain(
      `${MARKER}="stale"`,
    );
  });

  it("marks itself even with no error object at all", () => {
    expect(markup(null)).toContain(MARKER);
  });

  it("is the attribute the smoke test actually looks for", () => {
    const smoke = readFileSync(resolve(process.cwd(), "scripts/route-smoke.mjs"), "utf8");
    expect(smoke).toContain(MARKER);
    /* A marker the runner finds but does not fail on would be worse than
       none: it would look like coverage. */
    expect(smoke).toMatch(/verdict\.startsWith\("crash"\)/);
  });
});
