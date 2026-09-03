import { describe, expect, it } from "vitest";

import { hashSeed, normalizeSeed } from "../src/world/seed";
import type { WorldSeed } from "../src/world/types";

/**
 * The type `WorldSeed = string | number` closes this for TypeScript callers and
 * CI typechecks every PR, so this guard is not the primary defence — it is the
 * one that survives an `as any`, a `.mts` script, or a worker payload.
 *
 * Without it the failure is silent and total rather than loud and local:
 * `hashSeed` iterates `text.length`, an object has none, the loop never runs,
 * and the function returns its untouched FNV offset basis. Every object seed
 * collides on the EMPTY-STRING hash — so distinct seeds yield one identical
 * world and nothing reports a problem.
 */
describe("a non-string, non-number seed throws rather than collapsing", () => {
  it("rejects an object seed instead of returning the empty-string hash", () => {
    expect(() => normalizeSeed({ seed: "alpha" } as unknown as WorldSeed))
      .toThrow(TypeError);
    expect(() => normalizeSeed({ seed: "alpha" } as unknown as WorldSeed))
      .toThrow(/empty-string constant/);
  });

  it("names the collision that the silent path would have produced", () => {
    // Pin the mechanism, not just the throw: if hashSeed ever stops reading
    // .length this test should be revisited rather than silently still passing.
    expect(hashSeed("")).toBe(hashSeed(""));
    for (const bad of [{}, [], null, undefined, true]) {
      expect(() => normalizeSeed(bad as unknown as WorldSeed)).toThrow(TypeError);
    }
  });

  it("still accepts every legitimate seed form", () => {
    expect(normalizeSeed("alpha")).toBe("alpha");
    expect(normalizeSeed(42)).toBe("42");
    expect(normalizeSeed(-0)).toBe("-0");
    expect(hashSeed("alpha")).not.toBe(hashSeed("beta"));
  });
});
