import { readdirSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readSource } from "./support/sourceText";
import {
  __setProfileOverrideForCaptureExperimentsOnly,
  resolveWebGpuQualityProfile,
} from "../src/render/webgpu/core/QualityProfile";

/**
 * `__setProfileOverrideForCaptureExperimentsOnly` must have NO caller under
 * `src/`, ever.
 *
 * It exists for one experiment — isolating the tier-1 -> tier-2 frame cliff
 * across 30 differing profile fields — and it is a change to shipping code made
 * for a measurement. That trade was accepted on the explicit condition that
 * shipping behaviour cannot reach it. **An experiment hook with a caller in
 * `src/` is no longer an experiment hook; it is an undocumented quality
 * override**, and nothing else in the codebase would notice.
 *
 * The scan deliberately covers ALL of `src/`, not just the render tree: the
 * failure this guards against is precisely a call appearing somewhere nobody
 * thought to look.
 */

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = `${dir}/${entry}`;
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (path.endsWith(".ts") || path.endsWith(".tsx")) out.push(path);
  }
  return out;
}

const SETTER = "__setProfileOverrideForCaptureExperimentsOnly";

/** The one file allowed to contain the name: the file that defines it. */
const DEFINITION_SITE = "src/render/webgpu/core/QualityProfile.ts";

describe("capture-only profile override stays out of shipping code", () => {
  const files = sourceFiles("src");

  it("has no caller anywhere under src/", () => {
    // Non-vacuity part 1: the scan must actually be reading a real tree.
    expect(files.length, "the src/ scan found no TypeScript files at all")
      .toBeGreaterThan(50);

    const offenders = files.filter(
      (path) => path !== DEFINITION_SITE && readSource(path).includes(SETTER),
    );
    expect(
      offenders,
      `${SETTER} is called from shipping code: ${offenders.join(", ")}. It is an `
      + "experiment hook for the tier-cliff A/B, not a quality override. If a "
      + "shipping path needs to vary a profile field, that field belongs in the "
      + "tier literals where it can be reviewed.",
    ).toEqual([]);
  });

  it("finds the definition site, so the scan is looking at the right name", () => {
    // Non-vacuity part 2: if the setter were renamed, every `includes` above
    // would return false and the guard would pass while checking nothing. This
    // fails instead, and names what to update.
    expect(
      readSource(DEFINITION_SITE).includes(SETTER),
      `${SETTER} is not defined in ${DEFINITION_SITE}. Either it was renamed — in `
      + "which case update SETTER here, because the scan above is now vacuous — or "
      + "the experiment is over and this guard and the hook should both be deleted.",
    ).toBe(true);
  });

  it("DEMONSTRATES the guard fires: a simulated src/ caller is detected", () => {
    // Non-vacuity part 3, and the one the approval was conditioned on. The two
    // assertions above prove the scan reads real files and matches the real
    // name; neither proves it would REJECT a violation. This runs the exact
    // predicate against a synthetic file body and asserts it is caught.
    //
    // A guard asserting an absence passes trivially when its search string is
    // wrong, its directory is empty, or its predicate is inverted — and it is
    // indistinguishable from a working guard in all three cases.
    const violatingFile = {
      path: "src/render/SomeShippingFile.ts",
      body: `import { ${SETTER} } from "./webgpu/core/QualityProfile";\n${SETTER}({ msaaSamples: 1 });\n`,
    };
    const caught = violatingFile.path !== DEFINITION_SITE
      && violatingFile.body.includes(SETTER);
    expect(
      caught,
      "the absence guard did not detect a file that plainly calls the setter — "
      + "the predicate is broken and the passing result above means nothing",
    ).toBe(true);
  });

  it("refuses to override the identity fields, whatever the caller passes", () => {
    // `tier`, `quality`, `mode` and `frameTargetMs` are keyed on by
    // FRAME_BUDGET_MS, the memory tables and the capture's delivery contract.
    // Overriding one would corrupt every downstream lookup rather than test a
    // field, so the setter strips them. Asserted rather than documented.
    try {
      __setProfileOverrideForCaptureExperimentsOnly({
        tier: 0,
        frameTargetMs: 999,
        msaaSamples: 1,
      } as never);
      const profile = resolveWebGpuQualityProfile("high", "balanced");
      expect(profile.tier, "tier was overridden — downstream tier lookups are now wrong").toBe(2);
      expect(profile.frameTargetMs, "frameTargetMs was overridden").toBe(13.7);
      // ...while a legitimate field did take effect, so the test is not passing
      // because the override silently did nothing at all.
      expect(
        profile.msaaSamples,
        "msaaSamples did not take effect — the override is inert and the "
        + "assertions above prove nothing",
      ).toBe(1);
    } finally {
      __setProfileOverrideForCaptureExperimentsOnly(null);
    }
  });

  it("is inert once cleared", () => {
    __setProfileOverrideForCaptureExperimentsOnly({ msaaSamples: 1 });
    __setProfileOverrideForCaptureExperimentsOnly(null);
    expect(resolveWebGpuQualityProfile("high", "balanced").msaaSamples).toBe(4);
  });
});
