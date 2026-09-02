/**
 * The comment-stripping helper, guarded — because 41 guards now depend on it.
 *
 * **A silent bug here weakens every one of them at once**, and in the direction
 * nobody checks: strip too little and prose still satisfies code assertions,
 * which is the defect the helper exists to remove. So this file asserts the
 * strip actually strips, that it does not fuse identifiers, and that its two
 * known limits behave as documented rather than as a surprise.
 */
import { describe, expect, it } from "vitest";
import { stripComments } from "./support/sourceText";

describe("stripComments", () => {
  it("removes the block comment that would otherwise satisfy a code assertion", () => {
    // The exact shape of the live defect: an identifier that appears ONLY in a
    // docblock explaining why it is not used.
    const source = `
      /** 7-9: PCSS stays declined — we do not set FILTER_PCF here. */
      const filter = ShadowGenerator.FILTER_PCFSOFT;
    `;
    expect(source).toContain("FILTER_PCF");          // raw text: matches
    expect(stripComments(source)).not.toContain("FILTER_PCF,");
    // And the real assignment survives, so the guard still sees the code.
    expect(stripComments(source)).toContain("FILTER_PCFSOFT");
  });

  it("removes line comments", () => {
    expect(stripComments("const a = 1; // mentions forbiddenThing\n")).not.toContain("forbiddenThing");
  });

  it("does NOT fuse identifiers across a removed comment", () => {
    // FAILS IF: comments are replaced with "" instead of " ". `foo/**/bar`
    // would become `foobar` — an identifier present in NO file, which could
    // satisfy or defeat an assertion by pure accident.
    expect(stripComments("foo/* x */bar")).not.toContain("foobar");
    expect(stripComments("foo/* x */bar")).toContain("foo");
    expect(stripComments("foo/* x */bar")).toContain("bar");
  });

  it("spares a URL, which is the common in-string case", () => {
    expect(stripComments('const u = "https://example.com/path";')).toContain("https://example.com/path");
  });

  it("DOES strip inside other string literals — the documented limit", () => {
    // Not a bug to fix here; a reason to use `rawSource` when a guard searches
    // for a string containing comment syntax. Asserted so the limit is a known
    // property rather than something a future reader discovers by being wrong.
    const source = 'const s = "a // b";';
    expect(stripComments(source)).not.toContain("a // b");
  });

  it("leaves ordinary code untouched", () => {
    const code = "export const RATE = 1.5;\nfunction f(x: number) { return x * RATE; }\n";
    expect(stripComments(code)).toContain("export const RATE = 1.5;");
    expect(stripComments(code)).toContain("return x * RATE;");
  });
});
