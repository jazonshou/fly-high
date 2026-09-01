import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveWebGpuQualityProfile } from "../src/render/webgpu/core/QualityProfile";
import { PERF_CAPTURE_INVENTORIED_MEMORY_CEILING_MIB } from "../scripts/perf-capture.mts";

/**
 * `7-9` — the moonlight-shadow trade, **measured rather than inherited.**
 *
 * Gate 7A deviation 4 declined a second cascade set for the moon on judgement.
 * The plan requires 7-9 to turn that into a number, and the number is decisive
 * enough that this can be settled without a capture: it is a MEMORY question,
 * and memory does not need the host.
 *
 * **A moon cascade set is a full duplicate.** A `CascadedShadowGenerator` owns
 * one array texture of `shadowMapSize² × shadowCascades`; a second light with
 * its own generator allocates a second one at the same tier settings. The depth
 * target is 4 bytes per texel — `DepthOnlyCascadedShadowGenerator` already
 * reclaims the colour attachment, so this is the irreducible remainder, not a
 * figure that better allocation could shrink.
 *
 * **What it is measured AGAINST is the part that is easy to get wrong.** There
 * are two GPU-memory numbers and they disagree by over 100 MiB:
 * `estimatedGpuMemoryMiB` reads 367.5–380.7 while `inventoriedGpuMemoryMiB`
 * reads 483.9–492.3. **The inventory is the real one** — it walks the actual
 * scene textures and buffers, where the estimate models them — so the binding
 * headroom is `PERF_CAPTURE_INVENTORIED_MEMORY_CEILING_MIB` minus the WORST
 * observed inventory, not minus a comfortable one.
 *
 * The answer is no at every tier, by a wide margin, and this file exists so the
 * next person proposing moon shadows can read the margin instead of relitigating
 * the judgement.
 */

const MIB = 1024 * 1024;
const DEPTH_BYTES_PER_TEXEL = 4;
/**
 * The shadow map's COLOUR attachment, which `1A-5` deleted. R16F is the
 * Babylon default and the size that makes the retired figure check out:
 * 4096² × 4 cascades × 2 B is the ~128 MiB that deletion reclaimed.
 */
const COLOUR_BYTES_PER_TEXEL = 2;

/** The worst tier-1 inventory observed across baseline shots (`perf-capture.mts`). */
const WORST_OBSERVED_INVENTORY_MIB = 492.3;

/** What a SECOND cascade set costs at a tier, in MiB. */
function duplicateCascadeSetMiB(shadowMapSize: number, cascades: number): number {
  return (shadowMapSize * shadowMapSize * cascades * DEPTH_BYTES_PER_TEXEL) / MIB;
}

/** One profile per tier, resolved from the shipping resolver rather than restated. */
const TIER_PROFILES = [
  { tier: 0, quality: "low", mode: "balanced" },
  { tier: 1, quality: "medium", mode: "balanced" },
  { tier: 2, quality: "high", mode: "balanced" },
  { tier: 3, quality: "high", mode: "ultra" },
] as const;

/** What buying BACK the deleted colour attachment costs at a tier, in MiB. */
function colourAttachmentMiB(shadowMapSize: number, cascades: number): number {
  return (shadowMapSize * shadowMapSize * cascades * COLOUR_BYTES_PER_TEXEL) / MIB;
}

describe("7-9: the moonlight-shadow trade is a measured no", () => {
  it("resolves one profile per tier, so the costs below describe the shipped rows", () => {
    for (const row of TIER_PROFILES) {
      const profile = resolveWebGpuQualityProfile(row.quality, row.mode);
      expect(profile.tier, `${row.quality}/${row.mode} no longer resolves to tier ${row.tier}`)
        .toBe(row.tier);
    }
  });

  it("prices a second cascade set at every tier", () => {
    const costs = TIER_PROFILES.map((row) => {
      const p = resolveWebGpuQualityProfile(row.quality, row.mode);
      return duplicateCascadeSetMiB(p.shadowMapSize, p.shadowCascades);
    });
    // 1024²×2, 1280²×2, 1536²×3, 2048²×4 at 4 B/texel.
    expect(costs.map((c) => Math.round(c * 10) / 10)).toEqual([8, 12.5, 27, 64]);
    // Non-vacuity: the tiers must actually differ, or the table below is one
    // number restated four times.
    expect(new Set(costs).size).toBe(4);
  });

  it("THE ANSWER — a duplicate exceeds the whole inventoried headroom at EVERY tier", () => {
    const headroomMiB = PERF_CAPTURE_INVENTORIED_MEMORY_CEILING_MIB - WORST_OBSERVED_INVENTORY_MIB;
    // The headroom is real but tiny: single-digit MiB, not tens.
    expect(headroomMiB).toBeGreaterThan(0);
    expect(headroomMiB).toBeLessThan(5);

    for (const row of TIER_PROFILES) {
      const p = resolveWebGpuQualityProfile(row.quality, row.mode);
      const cost = duplicateCascadeSetMiB(p.shadowMapSize, p.shadowCascades);
      expect(
        cost,
        `a moon cascade set at tier ${row.tier} costs ${cost.toFixed(1)} MiB against `
        + `${headroomMiB.toFixed(1)} MiB of headroom`,
      ).toBeGreaterThan(headroomMiB);
    }

    // The margin, stated so it cannot be read as marginal: even the CHEAPEST
    // tier wants multiples of the entire remaining budget.
    const cheapest = Math.min(...TIER_PROFILES.map((row) => {
      const p = resolveWebGpuQualityProfile(row.quality, row.mode);
      return duplicateCascadeSetMiB(p.shadowMapSize, p.shadowCascades);
    }));
    expect(cheapest / headroomMiB).toBeGreaterThan(2.5);
  });

  it("the estimate is NOT the number to judge against, and disagrees by over 100 MiB", () => {
    // Recorded because judging the trade against `estimatedGpuMemoryMiB` would
    // show ~115 MiB of apparent room and reverse the answer. The estimate
    // models the scene; the inventory walks it.
    const estimatedWorst = 380.7;
    expect(WORST_OBSERVED_INVENTORY_MIB - estimatedWorst).toBeGreaterThan(100);
    const apparentHeadroom = PERF_CAPTURE_INVENTORIED_MEMORY_CEILING_MIB - estimatedWorst;
    expect(apparentHeadroom).toBeGreaterThan(100);
    // ... and against that phantom headroom, tier 1 would look affordable.
    expect(duplicateCascadeSetMiB(1_280, 2)).toBeLessThan(apparentHeadroom);
  });
});

/**
 * `7-9`'s second standing residual, declined on the SAME ceiling and for the
 * same reason — recorded so it is not left open a fourth phase.
 *
 * `QualityProfile`'s tier-2 note states it exactly: `computeShadowWithCSMPCSS`
 * needs a second `texture_2d_array<f32>` bound from the shadow map's COLOUR
 * attachment, and `1A-5` deleted that attachment as the single largest memory
 * win in Phase 1. The note calls buying it back "a Phase 7 conversation". This
 * is that conversation, and it is short: the buy-back is multiples of the
 * remaining headroom at the tiers that would use it.
 */
describe("7-9: PCSS stays declined, with the price rather than the judgement", () => {
  it("the tier-2 note that defers this is still the shipping one", () => {
    // The decline below is only binding while the reason it cites is real.
    const source = readFileSync("src/render/webgpu/core/QualityProfile.ts", "utf8");
    expect(
      source.includes("`computeShadowWithCSMPCSS` needs a second"),
      "the PCSS deferral note moved or changed; re-derive before quoting this decline",
    ).toBe(true);
    expect(source.includes("filter: ShadowGenerator.FILTER_PCF")
      || source.includes("FILTER_PCF")).toBe(true);
  });

  it("reproduces the retired 128 MiB figure, so the byte size is the right one", () => {
    // Non-vacuity for `COLOUR_BYTES_PER_TEXEL`: if R16F were the wrong format
    // every number below would be wrong by the same factor and still look
    // self-consistent. 1A-5's own figure is the check.
    expect(colourAttachmentMiB(4_096, 4)).toBeCloseTo(128, 6);
  });

  it("THE DECLINE — buying the attachment back exceeds the headroom where PCSS was published", () => {
    const headroomMiB = PERF_CAPTURE_INVENTORIED_MEMORY_CEILING_MIB - WORST_OBSERVED_INVENTORY_MIB;
    // §5.3 published PCSS at High and Ultra — tiers 2 and 3.
    for (const row of TIER_PROFILES.filter((r) => r.tier >= 2)) {
      const p = resolveWebGpuQualityProfile(row.quality, row.mode);
      const cost = colourAttachmentMiB(p.shadowMapSize, p.shadowCascades);
      expect(
        cost,
        `restoring the colour attachment at tier ${row.tier} costs ${cost.toFixed(1)} MiB `
        + `against ${headroomMiB.toFixed(1)} MiB of headroom`,
      ).toBeGreaterThan(headroomMiB);
    }
    // Tier 2 alone is five times the whole remaining budget.
    expect(colourAttachmentMiB(1_536, 3) / headroomMiB).toBeGreaterThan(5);
  });

  it("and it is CHEAPER than the moon trade, which is why both had to be priced", () => {
    // A useful ordering rather than a coincidence: PCSS buys back a 2 B/texel
    // attachment where a moon cascade set duplicates the 4 B/texel depth. So
    // rejecting the moon trade does not automatically reject PCSS, and the two
    // needed separate numbers rather than one argument.
    expect(colourAttachmentMiB(1_536, 3)).toBeLessThan(duplicateCascadeSetMiB(1_536, 3));
  });
});
