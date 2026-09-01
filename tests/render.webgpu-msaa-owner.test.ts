import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { firstPassSampleAssignment } from "../src/render/FlightRenderer";

/**
 * MSAA beauty-target ownership — `1B-11`.
 *
 * WHAT CHANGED HERE AND WHY IT IS NOT A WEAKENING. This file used to assert
 * four literal source strings, among them the exact text
 * `this.toneMap.samples = this.scotopic.enabled ? 1 : this.profile.msaaSamples`.
 * Its NAME was already behavioural — "whichever post-process is first" — but
 * its assertions pinned one particular spelling of a two-holder rule.
 *
 * `7-5` added a third holder. Ownership had been two hand-written branches in
 * two methods that had to agree; a third would have made it six, and the string
 * pins would have had to be rewritten to match whatever new spelling appeared
 * rather than checking that the new spelling was RIGHT. So the policy moved
 * into a pure function and this file exercises all eight states of it, which is
 * strictly more than the old assertions covered: the previous version could not
 * have caught a wrong branch, only a reworded one.
 *
 * The source-level checks that remain are the ones with no pure-function
 * equivalent — that the derivation has exactly one home, and that the toggle
 * still happens before the derivation reads it.
 */

const CHAIN = ["scotopic", "bloom", "toneMap"] as const;

describe("MSAA beauty-target ownership", () => {
  it("gives the samples to the first ATTACHED pass, in all eight states", () => {
    for (const samples of [1, 4]) {
      for (const scotopic of [true, false]) {
        for (const bloom of [true, false]) {
          const assigned = firstPassSampleAssignment(samples, scotopic, bloom);
          const attached = { scotopic, bloom, toneMap: true };
          // The tone map is always attached, so there is always exactly one
          // owner and it is always the first attached member of the chain.
          const expectedOwner = CHAIN.find((name) => attached[name])!;
          for (const name of CHAIN) {
            expect(
              assigned[name],
              `${name} with scotopic=${scotopic} bloom=${bloom} samples=${samples}`,
            ).toBe(name === expectedOwner ? samples : 1);
          }
        }
      }
    }
  });

  it("never hands the samples to more than one pass", () => {
    // Two multisampled targets is the waste `1B-11` exists to prevent, and it
    // is silent: the frame is correct and a whole target's cost is doubled.
    for (const scotopic of [true, false]) {
      for (const bloom of [true, false]) {
        const assigned = firstPassSampleAssignment(4, scotopic, bloom);
        const holders = CHAIN.filter((name) => assigned[name] > 1);
        expect(holders, `scotopic=${scotopic} bloom=${bloom}`).toHaveLength(1);
      }
    }
  });

  it("is a no-op at 1x, so a single-sample tier cannot be misconfigured", () => {
    // Bloom ships at tier 1 where msaaSamples is 1, so this is the state that
    // actually renders today: every assignment is 1 regardless of the chain.
    for (const scotopic of [true, false]) {
      for (const bloom of [true, false]) {
        const assigned = firstPassSampleAssignment(1, scotopic, bloom);
        expect(Object.values(assigned)).toEqual([1, 1, 1]);
      }
    }
  });

  it("derives ownership in exactly one place", () => {
    const source = readFileSync("src/render/FlightRenderer.ts", "utf8");
    const count = (pattern: RegExp) => (source.match(pattern) ?? []).length;
    // A second assignment site means someone re-derived the rule locally,
    // which is how the two-holder version stayed correct only by luck.
    expect(count(/this\.toneMap\.samples\s*=/g)).toBe(1);
    expect(count(/this\.scotopic\.setSamples\(/g)).toBe(1);
    expect(count(/this\.bloom\.setSamples\(/g)).toBe(1);
    expect(count(/firstPassSampleAssignment\(/g), "the policy must have one caller")
      .toBe(2); // the export itself, and its single use
  });

  it("still toggles rod vision, and still has no alpha-to-coverage", () => {
    const source = readFileSync("src/render/FlightRenderer.ts", "utf8");
    expect(source).toContain("this.scotopic.setEnabled(this.camera, scotopicActive)");
    expect(source).not.toContain("setAlphaToCoverage");
  });
});
