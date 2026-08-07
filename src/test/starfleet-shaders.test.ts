/**
 * A backtick inside a GLSL template literal silently ends the string.
 *
 * This has now happened twice, in two different files, and both times the
 * symptom was a wall of TypeScript parse errors a hundred lines away from the
 * cause — because everything after the stray backtick is parsed as code. The
 * trigger is innocent: writing `heightAt` in a doc comment *inside* the
 * shader, exactly the way it is written everywhere else in the codebase.
 *
 * So the rule is checked rather than remembered.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : full.endsWith(".ts") ? [full] : [];
  });
}

const files = walk(join(process.cwd(), "src", "starfleet"));

describe("the shaders", () => {
  it("never puts a backtick inside a GLSL template literal", () => {
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/\/\* glsl \*\/\s*`([\s\S]*?)\n`/g)) {
        expect(m[1].includes("`"), `${file}: stray backtick ends the shader early`).toBe(false);
      }
    }
  });

  it("balances braces in every shader it declares", () => {
    // A truncated shader still "compiles" as a string and fails at link time
    // inside the browser, which the build never sees.
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/\/\* glsl \*\/\s*`([\s\S]*?)\n`/g)) {
        const body = m[1];
        const open = (body.match(/\{/g) ?? []).length;
        const close = (body.match(/\}/g) ?? []).length;
        expect(open, `${file}: unbalanced braces in a shader`).toBe(close);
      }
    }
  });

  it("declares a main() in every shader", () => {
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/\/\* glsl \*\/\s*`([\s\S]*?)\n`/g)) {
        // Chunk fragments patched into three's shaders have no main of their own.
        if (!/gl_Position|gl_FragColor/.test(m[1])) continue;
        expect(/void\s+main\s*\(/.test(m[1]), `${file}: a shader with no main()`).toBe(true);
      }
    }
  });
});
