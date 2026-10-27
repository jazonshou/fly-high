import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { QualityLevel } from "../src/game/types";
import type { RenderingMode } from "../src/settings";
import {
  resolveWebGpuQualityProfile,
  type WebGpuQualityProfile,
} from "../src/render/webgpu/core/QualityProfile";
import { GROUND_COVER_LAWS } from "../src/render/webgpu/detail/groundCoverLaw";

/**
 * PR B part 2 cuts tier 0 and must move nothing above it (design §11). The
 * 39 reference pictures are tier 1, and the captures pin the governor, so a
 * tier-1 profile value that moved would move a picture; tiers 2 and 3 are
 * not this PR's to change either.
 *
 * `tests/fixtures/profiles-before-part2.json` was written once at the PR
 * base (5f8085b), before the first commit: `JSON.stringify` of the resolved
 * profile for all nine quality × mode pairs. Every tier-1-3 pair must still
 * resolve to it, the fields this PR adds aside, and tier 0 to it but for the
 * two values its cuts move (the pixel cap and the ground-cover fade).
 *
 * TEMPORARY. Kept for good, a snapshot of nine resolved profiles would pin
 * every tier-1-3 field for the next planned changes (Medium's 1.2 Mpx cap,
 * batch B), though it exists only to prove this PR's claim. PR B part 2's
 * last commit deletes the fixture and every comparison against it; the last
 * block below, the new fields at identity above tier 0, is the invariant
 * that stays.
 */

/** The fields PR B part 2 adds to the profile; the fixture predates them. */
const NEW_FIELDS = ["shadowRefreshFrames", "cloudDepthRefreshFrames", "governorPixelFloorRatio"] as const;

const PAIRS: readonly (readonly [QualityLevel, RenderingMode])[] = [
  ["low", "performance"],
  ["low", "balanced"],
  ["low", "ultra"],
  ["medium", "performance"],
  ["medium", "balanced"],
  ["medium", "ultra"],
  ["high", "performance"],
  ["high", "balanced"],
  ["high", "ultra"],
];

type Plain = Record<string, unknown>;

const FIXTURE = JSON.parse(
  readFileSync(join(import.meta.dirname, "fixtures", "profiles-before-part2.json"), "utf8"),
) as Record<string, Plain>;

/** A resolved profile as the fixture holds it (through JSON), less `omit`. */
function plain(profile: WebGpuQualityProfile, omit: readonly string[] = NEW_FIELDS): Plain {
  const out = JSON.parse(JSON.stringify(profile)) as Plain;
  for (const key of omit) delete out[key];
  return out;
}

/** Tier 0's cuts (design §8.1, §8.2): the pixel cap and the ground-cover fade's upper edge. */
function withoutTierZeroCuts(profile: Plain): Plain {
  const groundCoverLaw: Plain = { ...(profile.groundCoverLaw as Plain) };
  delete groundCoverLaw.altitudeFadeHighMeters;
  const out: Plain = { ...profile, groundCoverLaw };
  delete out.maxRenderPixels;
  return out;
}

describe("the nine profiles against the PR base (until PR B part 2 lands)", () => {
  it("INSTRUMENT — the fixture holds all nine pairs, before the new fields, and a changed field fails", () => {
    expect(Object.keys(FIXTURE).sort()).toEqual(PAIRS.map(([quality, mode]) => `${quality}/${mode}`).sort());
    for (const [key, profile] of Object.entries(FIXTURE)) {
      expect(Object.keys(profile).length, key).toBeGreaterThan(40);
      for (const field of NEW_FIELDS) expect(profile, key).not.toHaveProperty(field);
    }
    // The comparison below sees a one-field change, and stripping the new
    // fields leaves every other one in.
    const medium = resolveWebGpuQualityProfile("medium", "balanced");
    expect(plain({ ...medium, cdlodNodeBudget: medium.cdlodNodeBudget + 1 })).not.toEqual(FIXTURE["medium/balanced"]);
    expect(Object.keys(plain(medium))).toHaveLength(Object.keys(medium).length - NEW_FIELDS.length);
    // So does tier 0's, outside the two values its cuts move.
    const low = resolveWebGpuQualityProfile("low", "balanced");
    expect(withoutTierZeroCuts(plain({ ...low, renderScale: 0.66 })))
      .not.toEqual(withoutTierZeroCuts(FIXTURE["low/balanced"]!));
  });

  it("tiers 1-3 resolve exactly as they did, but for the new fields", () => {
    let compared = 0;
    for (const [quality, mode] of PAIRS) {
      const profile = resolveWebGpuQualityProfile(quality, mode);
      if (profile.tier === 0) continue;
      expect(plain(profile), `${quality} ${mode}`).toEqual(FIXTURE[`${quality}/${mode}`]);
      compared += 1;
    }
    expect(compared).toBe(6);
  });

  it("tier 0 moves only its pixel cap and its ground-cover fade, and the new fields", () => {
    let compared = 0;
    for (const [quality, mode] of PAIRS) {
      const profile = resolveWebGpuQualityProfile(quality, mode);
      if (profile.tier !== 0) continue;
      expect(withoutTierZeroCuts(plain(profile)), `${quality} ${mode}`)
        .toEqual(withoutTierZeroCuts(FIXTURE[`${quality}/${mode}`]!));
      compared += 1;
    }
    expect(compared).toBe(3);
  });

  it("leaves tier 1's ground-cover law alone", () => {
    expect(JSON.parse(JSON.stringify(GROUND_COVER_LAWS[1]))).toEqual(FIXTURE["medium/balanced"]!.groundCoverLaw);
  });
});

describe("the new profile fields above tier 0", () => {
  it("refresh the sun shadow and the cloud depth every frame on every pair above tier 0", () => {
    // Part 2b adds `cadenceFallbackHz` 0 here.
    let pairs = 0;
    for (const [quality, mode] of PAIRS) {
      const profile = resolveWebGpuQualityProfile(quality, mode);
      if (profile.tier === 0) continue;
      expect(profile.shadowRefreshFrames, `${quality} ${mode}`).toBe(1);
      expect(profile.cloudDepthRefreshFrames, `${quality} ${mode}`).toBe(1);
      pairs += 1;
    }
    expect(pairs).toBe(6);
  });
});
