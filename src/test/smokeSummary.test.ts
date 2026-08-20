/**
 * What `npm run smoke` reports, and — the part that had the bug — what it
 * exits with.
 *
 * There was already a test guarding this. It read route-smoke.mjs as text and
 * asserted the source contained `verdict.startsWith("crash")`, with the note
 * "a marker the runner finds but does not fail on would be worse than none: it
 * would look like coverage." That was exactly the right worry, and the test
 * did not catch it: the string appears in the line that picks the FAIL label,
 * while the summary counted only `blank` and the process exited 0. A world
 * could crash on its first frame and the run would end green.
 *
 * So this one asserts on the arithmetic instead of on the source text. A test
 * that greps for an implementation detail passes for the wrong reasons.
 */
import { describe, it, expect } from "vitest";
import { isFailure, summarise } from "../../scripts/lib/smokeSummary.mjs";

const ok = (route: string, verdict = "canvas") => ({ route, verdict, errors: [] });
const blank = (route: string) => ({ route, verdict: "blank", errors: [] });
const crashed = (route: string, msg = "boom") => ({
  route, verdict: `crash:${msg}`, errors: [],
});

describe("what counts as a failure", () => {
  it("passes a route that raised a canvas or any text", () => {
    expect(isFailure("canvas")).toBe(false);
    expect(isFailure("text")).toBe(false);
  });

  it("fails a blank route", () => {
    expect(isFailure("blank")).toBe(true);
  });

  it("fails a crashed route, whatever the message says", () => {
    expect(isFailure("crash:")).toBe(true);
    expect(isFailure("crash:TypeError: x is not a function")).toBe(true);
  });
});

describe("the summary", () => {
  it("exits 0 only when every route came up", () => {
    expect(summarise([ok("/a"), ok("/b", "text")]).exitCode).toBe(0);
  });

  it("exits non-zero on a blank route", () => {
    expect(summarise([ok("/a"), blank("/b")]).exitCode).toBe(1);
  });

  it("exits non-zero on a CRASHED route", () => {
    /* The regression. A crash is not blank, so the old summary counted it
       among the routes that rendered something and exited 0 — the crash
       screen is text, and it is the worst verdict, not a middling one. */
    expect(summarise([ok("/a"), crashed("/b")]).exitCode).toBe(1);
  });

  it("does not count a crashed route as one that came up", () => {
    const s = summarise([ok("/a"), crashed("/b"), ok("/c")]);
    expect(s.rendered).toBe(2);
    expect(s.total).toBe(3);
    expect(s.headline).toBe("2/3 routes came up.");
  });

  it("names the routes that failed, and says which way they failed", () => {
    // A count tells you something broke; over fifty routes you need to be
    // told which, without scrolling back through the log to find out.
    const s = summarise([ok("/a"), crashed("/b", "TypeError: nope"), blank("/c")]);
    expect(s.detail).toEqual([
      "CRASHED  /b — TypeError: nope",
      "BLANK    /c",
    ]);
  });

  it("still names a crash that arrived without a message", () => {
    expect(summarise([crashed("/b", "")]).detail).toEqual(["CRASHED  /b — no message"]);
  });

  it("says nothing extra when everything is fine", () => {
    const s = summarise([ok("/a"), ok("/b")]);
    expect(s.detail).toEqual([]);
    expect(s.failures).toEqual([]);
  });

  it("handles a run with no routes at all rather than dividing by zero", () => {
    const s = summarise([]);
    expect(s.exitCode).toBe(0);
    expect(s.headline).toBe("0/0 routes came up.");
  });
});

/* -------------------------------------------------------------------------
 * A route that threw
 * ---------------------------------------------------------------------- */

/**
 * The second time this file's arithmetic scored a broken world as a pass.
 *
 * A half-written module went to a branch that deploys; `/empyrean` threw
 * `flyerParts is not defined` partway through booting, and the run printed
 * `ok /empyrean canvas` and exited 0 — because the renderer had appended its
 * canvas before the throw. A canvas is evidence that something started.
 */
describe("a route that threw", () => {
  it("is a failure even though it drew", () => {
    expect(isFailure("threw:canvas")).toBe(true);
    expect(isFailure("threw:text")).toBe(true);
    expect(isFailure("threw:blank")).toBe(true);
  });

  it("counts against the tally and exits non-zero", () => {
    const s = summarise([
      { route: "/a", verdict: "canvas", errors: [] },
      { route: "/b", verdict: "threw:canvas", errors: ["flyerParts is not defined"] },
    ]);
    expect(s.rendered).toBe(1);
    expect(s.total).toBe(2);
    expect(s.exitCode).toBe(1);
  });

  it("names the route and quotes what was thrown", () => {
    const s = summarise([
      { route: "/empyrean", verdict: "threw:canvas", errors: ["flyerParts is not defined"] },
    ]);
    expect(s.detail[0]).toContain("/empyrean");
    expect(s.detail[0]).toContain("flyerParts is not defined");
  });

  it("survives a thrown route with no message to quote", () => {
    const s = summarise([{ route: "/x", verdict: "threw:blank" }]);
    expect(s.exitCode).toBe(1);
    expect(s.detail[0]).toContain("/x");
  });
});

/**
 * A route the harness never ran.
 *
 * The distinction this guards is not cosmetic. A browser that dies partway
 * through a hundred-route run used to take the whole process down with it,
 * and the routes either side came back labelled `threw:crash:render` — ten
 * of them at once, on worlds that open perfectly when run on their own. A day
 * went into looking for a bug in those worlds. An unrun route has to read as
 * an unrun route, in the headline and not only in the small print, or the next
 * person spends the day too.
 */
describe("a route the browser never got to", () => {
  it("is a failure — an unrun route is not a passing route", () => {
    expect(isFailure("harness:browser is not connected")).toBe(true);
  });

  it("says so in the headline, so it does not read as a broken world", () => {
    const s = summarise([
      { route: "/a", verdict: "canvas", errors: [] },
      { route: "/b", verdict: "harness:browser is not connected", errors: [] },
      { route: "/c", verdict: "harness:browser is not connected", errors: [] },
    ]);
    expect(s.exitCode).toBe(1);
    expect(s.rendered).toBe(1);
    expect(s.headline).toContain("2 never ran");
    expect(s.headline).toContain("unknown, not broken");
  });

  it("is told apart from a world that crashed", () => {
    const s = summarise([
      { route: "/dead", verdict: "harness:browser is not connected", errors: [] },
      { route: "/broken", verdict: "crash:render", errors: [] },
    ]);
    expect(s.detail.find((d) => d.includes("/dead"))).toContain("NOT RUN");
    expect(s.detail.find((d) => d.includes("/broken"))).toContain("CRASHED");
  });

  it("leaves the headline alone when every route actually ran", () => {
    const s = summarise([
      { route: "/a", verdict: "canvas", errors: [] },
      { route: "/b", verdict: "blank", errors: [] },
    ]);
    expect(s.headline).not.toContain("never ran");
  });
});
