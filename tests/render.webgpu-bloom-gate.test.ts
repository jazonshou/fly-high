import { describe, expect, it } from "vitest";
import {
  resolveWebGpuQualityProfile,
} from "../src/render/webgpu/core/QualityProfile";
import type { QualityLevel } from "../src/game/types";
import type { RenderingMode } from "../src/settings";

/**
 * The four shipping tiers, resolved through the public API exactly as
 * `docs-truth.test.ts` does. Copied from there rather than re-derived: the
 * quality/mode pairs that produce tiers 0-3 are not guessable from the tier
 * numbers, and I guessed wrong once before reading them.
 */
const TIER_INPUTS: ReadonlyArray<readonly [QualityLevel, RenderingMode]> = [
  ["low", "balanced"],
  ["medium", "balanced"],
  ["high", "balanced"],
  ["high", "ultra"],
];
const QUALITY_PROFILES = TIER_INPUTS.map(([quality, mode]) =>
  resolveWebGpuQualityProfile(quality, mode));

/**
 * `7-5`: bloom's tier gate, asserted against the measurement that set it.
 *
 * The plan funded bloom against tier 2's 0.05 ms of MODELLED slack (D-4,
 * §2.3(g)). The sweep measured a 10.0-46.7 ms deficit at 0 of 21
 * shot-configurations. The gate is data rather than a `profile.tier` branch so
 * that a fidelity decision about 4x MSAA at tier 2 is a value change here, not
 * a redesign -- `msaaSamples` 4->1 alone recovers 32.79 ms of a 39.59 ms gap.
 */
describe("7-5 bloom tier gate", () => {
  it("is enabled only where headroom has actually been measured", () => {
    const enabled = QUALITY_PROFILES.filter((profile) => profile.bloomEnabled);
    expect(
      enabled.map((profile) => profile.tier),
      "bloom ships at tier 1 only: tier 0 is unmeasured, tiers 2+ are unfunded",
    ).toEqual([1]);
  });

  it("ships only where MSAA is 1x, so its cost carries one sample count", () => {
    // Not a coincidence worth leaving implicit: every tier bloom runs on is a
    // 1x tier, so the shipped bloom number is a 1x number and cannot silently
    // be quoted for a 4x tier. If this ever fails, bloom has been enabled
    // somewhere its cost must be re-measured before it is quoted.
    for (const profile of QUALITY_PROFILES) {
      if (!profile.bloomEnabled) continue;
      expect(
        profile.msaaSamples,
        `tier ${profile.tier} enables bloom at ${profile.msaaSamples}x MSAA; `
        + "its cost has only been reasoned about at 1x",
      ).toBe(1);
    }
  });

  it("keeps the gate independent of tier ordering", () => {
    // Non-vacuity: a gate that is false everywhere would pass the MSAA
    // assertion above trivially.
    expect(QUALITY_PROFILES.some((profile) => profile.bloomEnabled)).toBe(true);
    expect(QUALITY_PROFILES.some((profile) => !profile.bloomEnabled)).toBe(true);
  });
});
