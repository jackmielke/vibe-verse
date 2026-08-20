/**
 * What a smoke run means, separated from how it was gathered.
 *
 * This lives apart from `route-smoke.mjs` for one reason: that file opens a
 * browser at import time, so nothing can import it to test it. The verdict
 * arithmetic is the part most worth testing and was the part with the bug, so
 * it moved somewhere a test can reach.
 *
 * The bug, for the record. `route-smoke` has three verdicts — `canvas`, `text`
 * and `blank` — plus `crash:<message>` when the route renders the app's crash
 * screen. Each route printed the right label, `FAIL` for a crash included. But
 * the summary counted only `blank` as a failure:
 *
 *     const blank = results.filter((r) => r.verdict === "blank");
 *     console.log(`${results.length - blank.length}/${results.length} …`);
 *     process.exit(blank.length ? 1 : 0);
 *
 * A crashed route is not blank, so it was counted among the routes that
 * "rendered something", and the run exited 0. A world could crash on its first
 * frame and `npm run smoke` would end with a cheerful tally and a green exit —
 * in a loop or a CI job, indistinguishable from everything working.
 *
 * The crash screen is deliberately the *worst* verdict, not a middling one: a
 * blank route might still be loading, while a crashed one has already given up.
 * Counting it as a pass inverted that.
 */

/**
 * A second bug, in the same shape, found the same way.
 *
 * A half-written module was committed and pushed to a branch that deploys.
 * `/empyrean` threw `flyerParts is not defined` out of its vehicle builder
 * partway through booting, and smoke printed `ok /empyrean canvas` — because
 * the renderer had appended its canvas before the throw. A canvas is evidence
 * that something *started*, not that anything works, and an uncaught
 * exception is a failure however much got drawn before it.
 *
 * `threw:` carries the render verdict after it, because "threw, and never
 * drew" and "threw, but drew" are different bugs and the label should not
 * throw away which one you have.
 */

/** Verdicts that mean the route did not come up. */
export const isFailure = (verdict) =>
  verdict === "blank" ||
  String(verdict).startsWith("crash") ||
  String(verdict).startsWith("threw");

/**
 * Fold a run into what should be printed and what should be exited with.
 *
 * @param {{route: string, verdict: string, errors?: string[]}[]} results
 * @returns {{failures: object[], rendered: number, total: number,
 *            exitCode: number, headline: string, detail: string[]}}
 */
export function summarise(results) {
  const failures = results.filter((r) => isFailure(r.verdict));
  const total = results.length;
  const rendered = total - failures.length;

  const headline = `${rendered}/${total} routes came up.`;

  /* Name them. A count tells you something is wrong; the whole reason to run
     this over fifty routes is to be told WHICH one, without scrolling back
     through fifty lines to find the two that matter. */
  const detail = failures.map((f) => {
    if (f.verdict.startsWith("crash")) {
      return `CRASHED  ${f.route} — ${f.verdict.slice("crash:".length) || "no message"}`;
    }
    if (f.verdict.startsWith("threw")) {
      const first = f.errors?.[0] ?? "no message";
      return `THREW    ${f.route} — ${first}`;
    }
    return `BLANK    ${f.route}`;
  });

  return {
    failures,
    rendered,
    total,
    exitCode: failures.length ? 1 : 0,
    headline,
    detail,
  };
}
