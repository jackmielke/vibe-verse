/**
 * The one shader mistake in this world that cost weeks, and the shape of it.
 *
 * `normalize(cross(vec3(0.0, 1.0, 0.0), N))` is the standard way to build a
 * tangent from a normal, and it produces **NaN** whenever `N` is parallel to
 * the axis you crossed it with: the cross product is the zero vector, and
 * normalizing that divides by zero. On a tower that is one ring of pixels on
 * a ledge soffit — a handful of fragments out of a million, on surfaces
 * nobody photographs.
 *
 * They were not harmless. The NaN goes into the HDR target, the post chain
 * downsamples it, and a blur kernel spreads it across its entire tile. What
 * reaches the screen is a hard-edged black rectangle six hundred pixels
 * across — and it has *none* of the properties of the thing that caused it:
 *
 * - It does not shrink with distance, because a mip tile is a fixed size on
 *   screen. Two observers measured "constant angular width" and correctly
 *   concluded the vertex stage must be emitting view-relative coordinates.
 *   It was not; there is nothing wrong with the vertex stage.
 * - Its edges do not converge under perspective, because they are not
 *   world-space edges.
 * - Its interior is exactly the tone-mapped clear colour, so it reads as
 *   "nothing drew here" rather than "something drew wrong".
 *
 * It was blamed on the skybridges, which were parked for weeks and then
 * rewritten end to end without changing it — because it never came from
 * them. It was chased through `buildings.ts`, then `interiors.ts`, then
 * `spire.ts`, by three people, before anybody made a fragment shader print a
 * flag colour where its own output was not finite.
 *
 * ## Why this test greps
 *
 * `smokeSummary.test.ts` in this repo carries a warning against exactly this
 * style — "a test that greps for an implementation detail passes for the
 * wrong reasons" — and it is right in general. This is the exception, and
 * the reason is that there is no other place to stand:
 *
 * - The failure is in GLSL, which no unit test in this project executes.
 * - It is invisible in a render at almost every camera angle, and when it is
 *   visible it appears somewhere else entirely.
 * - Every other check this world has — typecheck, build, the world test's
 *   NaN-in-attribute sweep, the budget test — passed the whole time it was
 *   shipping.
 *
 * So the invariant is enforced where it can be: no shader in this world may
 * normalize a cross product against a **constant** axis without first
 * handling the case where the other operand is parallel to it. If you need
 * one, pick the axis: `abs(N.y) > 0.999 ? vec3(0,0,1) : vec3(0,1,0)`.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

/* From the project root, not from `import.meta.url`. Under this runner the
   module URL is not a file: URL — `new URL(...).pathname` yields an
   absolute-looking path that resolves from the filesystem root, and
   `fileURLToPath` throws outright. Vitest runs with the repo as its cwd, and
   `vitest.config` pins the root, so this is the stable anchor. */
const DIR = resolve(process.cwd(), "src/empyrean");

function sources(): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".ts")) out.push({ file: p.slice(DIR.length + 1), text: readFileSync(p, "utf8") });
    }
  };
  walk(DIR);
  return out;
}

/**
 * Every `normalize(cross(...))` against a constant axis that is not guarded.
 *
 * A cross of two varyings can also be degenerate, but only if the geometry
 * is, and `empyreanWorld.test.ts` already sweeps attributes for NaN. The
 * constant-axis form is the one that is degenerate for *correct* geometry —
 * a perfectly flat floor or ceiling is exactly the case that breaks it — and
 * it is the one that has actually shipped here.
 *
 * **Two guards are accepted**, because both are in use in this world and
 * both are right:
 *
 * - *Pick another axis.* `abs(N.y) > 0.999 ? vec3(0,0,1) : vec3(0,1,0)`.
 *   Exact, and the tangent stays meaningful right up to the pole. This is
 *   what the curtain walls use, where the basis carries a texture pattern
 *   that would visibly swim if it flipped.
 * - *Nudge the result off zero.* `normalize(cross(a, b) + vec3(0, 0, 1e-4))`.
 *   One term, no branch, and the direction it degenerates to is arbitrary but
 *   finite. This is what `crowd.ts` uses for a dog lead, where any
 *   perpendicular will do and a branch per vertex is not worth it.
 *
 * The parentheses are balanced by hand rather than by regex: the argument
 * contains nested `vec3(...)` calls and an epsilon term *outside* the cross,
 * and a non-greedy match cuts it in the wrong place — which it did, and
 * reported the already-guarded line in `crowd.ts` as a fault.
 */
function unguardedCrosses(text: string): string[] {
  const hits: string[] = [];
  const NEEDLE = "normalize(";
  for (let i = text.indexOf(NEEDLE); i !== -1; i = text.indexOf(NEEDLE, i + 1)) {
    /* Balance from the opening paren to find the whole argument. */
    let depth = 0;
    let end = -1;
    for (let j = i + NEEDLE.length - 1; j < text.length; j++) {
      if (text[j] === "(") depth++;
      else if (text[j] === ")") {
        depth--;
        if (depth === 0) {
          end = j;
          break;
        }
      }
    }
    if (end === -1) continue;
    const arg = text.slice(i + NEEDLE.length, end);
    if (!arg.trimStart().startsWith("cross(")) continue;
    if (!arg.includes("vec3(")) continue;

    /* Guard one: an epsilon added to the cross, i.e. a `+` at depth zero
       within the argument. */
    let d = 0;
    let nudged = false;
    for (const ch of arg) {
      if (ch === "(") d++;
      else if (ch === ")") d--;
      else if (ch === "+" && d === 0) nudged = true;
    }
    if (nudged) continue;

    /* Guard two: a parallelism branch on the axis, within the 400 characters
       before the call — far enough for a comment and the ternary, tight
       enough that an unrelated guard elsewhere in the shader does not
       count. */
    const before = text.slice(Math.max(0, i - 400), i);
    if (/abs\(\s*\w+\.[xyz]\s*\)\s*>\s*0?\.9/.test(before)) continue;

    hits.push(text.slice(i, end + 1).replace(/\s+/g, " "));
  }
  return hits;
}

describe("no shader normalizes a degenerate cross product", () => {
  it("guards every constant-axis tangent basis in the world", () => {
    const bad: string[] = [];
    for (const { file, text } of sources()) {
      for (const hit of unguardedCrosses(text)) bad.push(`${file}: ${hit}`);
    }
    expect(bad).toEqual([]);
  });

  it("would have caught the one that shipped", () => {
    /* The exact line that was in `spire.ts` and `buildings.ts`, so this test
       is demonstrably capable of failing rather than merely passing. */
    const shipped = `
      vec3 N = normalize(vNrm);
      vec3 T = normalize(cross(vec3(0.0, 1.0, 0.0), N));
      vec3 B = cross(N, T);
    `;
    expect(unguardedCrosses(shipped)).toHaveLength(1);
  });

  it("accepts the branch guard", () => {
    const fixed = `
      vec3 N = normalize(vNrm);
      vec3 upAxis = abs(N.y) > 0.999 ? vec3(0.0, 0.0, 1.0) : vec3(0.0, 1.0, 0.0);
      vec3 T = normalize(cross(upAxis, N));
    `;
    expect(unguardedCrosses(fixed)).toEqual([]);
  });

  it("accepts the epsilon guard, which is what crowd.ts already used", () => {
    /* The first version of this test balanced its parentheses with a
       non-greedy regex, cut this expression in the middle, and reported a
       correctly guarded line as a fault. A checker that cries wolf on the
       one place that got it right is worse than no checker. */
    const nudged = `
      vec3 dir = span / len;
      vec3 across = normalize(cross(dir, vec3(0.0, 1.0, 0.0)) + vec3(0.0, 0.0, 1e-4));
    `;
    expect(unguardedCrosses(nudged)).toEqual([]);
  });
});
