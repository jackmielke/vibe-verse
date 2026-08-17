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
