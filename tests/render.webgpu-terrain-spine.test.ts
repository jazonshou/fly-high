import { describe, expect, it } from "vitest";
import {
  DYNAMIC_ALLOCATIONS,
  estimateGpuMemoryBreakdown,
  type DynamicAllocationInputs,
} from "../src/render/webgpu/core/PerformanceBudget";
import { resolveWebGpuQualityProfile } from "../src/render/webgpu/core/QualityProfile";
import type { QualityLevel } from "../src/game/types";
import type { RenderingMode } from "../src/settings";
import {
  SEASON_BUCKETS,
  SEASON_BUCKETS_RESIDENT,
  TERRAIN_CHANNEL_FAMILIES,
  TERRAIN_CHANNEL_SLOT_EDGE,
  TERRAIN_HEIGHT_PYRAMID_EDGE,
  TERRAIN_HEIGHT_PYRAMID_SPAN_METERS,
  TERRAIN_HEIGHT_SLOT_EDGE,
  TERRAIN_NODES_PER_SLOT_EDGE,
  TERRAIN_NODE_GRID_RESOLUTION,
  TERRAIN_SAMPLED_BINDINGS,
  seasonBucket,
  seasonBucketBlend,
  seasonBucketCenterDay,
  terrainAtlasEdgeTexels,
  terrainAtlasGridEdge,
  terrainChannelBytesPerTexel,
  terrainHeightBytesPerTexel,
  terrainNodeSpanMeters,
  terrainPageFilterWidthMeters,
  terrainReadbackBytesPerRow,
  terrainSlotOrigin,
  terrainSupersampleOffsets,
  terrainTexelSizeMeters,
} from "../src/render/webgpu/terrain/TerrainSpineContract";
import { REQUIRED_WEBGPU_LIMITS } from "../src/render/webgpu/core/Capabilities";

const REFERENCE_VIEWPORT = { cssWidth: 1_512, cssHeight: 982, devicePixelRatio: 2 } as const;

const TIER_PROFILES = ([
  ["low", "performance"],
  ["medium", "balanced"],
  ["high", "balanced"],
  ["high", "ultra"],
] as const).map(([quality, mode]) =>
  resolveWebGpuQualityProfile(quality as QualityLevel, mode as RenderingMode));

/**
 * `4-0`'s gate. The terrain spine contract is the only thing eleven Phase 4
 * consumers agree through, so the properties they rely on are asserted here
 * rather than inside each consumer.
 */
describe("terrain spine contract (4-0)", () => {
  it("resolves one profile per tier, in order", () => {
    expect(TIER_PROFILES.map((profile) => profile.tier)).toEqual([0, 1, 2, 3]);
  });

  // Assertion 68.
  it("keeps texel size tier-independent and derived from the page geometry", () => {
    // §5.3's Ultra "1 m L0 texel spacing" row is inexpressible: level-L texel
    // size is 512·2^L / 256 = 2·2^L m by the normative page geometry, and a
    // tier-dependent value would fork the §1.3 height authority on a graphics
    // setting.
    expect(terrainTexelSizeMeters.length).toBe(1);
    for (let level = 0; level <= 8; level += 1) {
      expect(terrainTexelSizeMeters(level)).toBeCloseTo(2 * 2 ** level, 9);
    }
    // Low reaches 4 m by never streaming L0 — not by storing a coarser page.
    expect(TIER_PROFILES[0]!.finestResidentLevel).toBe(1);
    expect(terrainTexelSizeMeters(TIER_PROFILES[0]!.finestResidentLevel)).toBe(4);
    for (const profile of TIER_PROFILES.slice(1)) {
      expect(profile.finestResidentLevel).toBe(0);
    }
  });

  it("makes a CDLOD node span exactly the page's own texel spacing", () => {
    // 8×8 nodes per slot, 32 quads per node edge: 512·2^L / 8 / 32 = 2·2^L.
    for (let level = 0; level <= 6; level += 1) {
      const quadMeters =
        terrainNodeSpanMeters(level) / (TERRAIN_NODE_GRID_RESOLUTION - 1);
      expect(quadMeters).toBeCloseTo(terrainTexelSizeMeters(level), 9);
    }
    expect(TERRAIN_NODES_PER_SLOT_EDGE).toBe(8);
  });

  it("derives slot edges from the one page geometry", () => {
    expect(TERRAIN_HEIGHT_SLOT_EDGE).toBe(264);
    expect(TERRAIN_CHANNEL_SLOT_EDGE).toBe(136);
    expect(terrainAtlasGridEdge(196)).toBe(14);
    expect(terrainAtlasEdgeTexels(256, TERRAIN_HEIGHT_SLOT_EDGE)).toBe(4_224);
    expect(terrainAtlasEdgeTexels(256, TERRAIN_CHANNEL_SLOT_EDGE)).toBe(2_176);
    // Every atlas edge fits under the DEVICE limit, which is the spec default
    // (8192), not the adapter's 16384 (assertion 70c).
    for (const profile of TIER_PROFILES) {
      expect(terrainAtlasEdgeTexels(profile.heightAtlasSlots, TERRAIN_HEIGHT_SLOT_EDGE))
        .toBeLessThanOrEqual(REQUIRED_WEBGPU_LIMITS.maxTextureDimension2D!);
      expect(terrainAtlasEdgeTexels(profile.channelAtlasSlots, TERRAIN_CHANNEL_SLOT_EDGE))
        .toBeLessThanOrEqual(REQUIRED_WEBGPU_LIMITS.maxTextureDimension2D!);
    }
  });

  it("maps every slot index into the atlas without overlap", () => {
    const slots = 196;
    const seen = new Set<string>();
    for (let index = 0; index < slots; index += 1) {
      const origin = terrainSlotOrigin(index, slots, TERRAIN_CHANNEL_SLOT_EDGE);
      expect(origin.u % TERRAIN_CHANNEL_SLOT_EDGE).toBe(0);
      expect(origin.v % TERRAIN_CHANNEL_SLOT_EDGE).toBe(0);
      expect(origin.u).toBeLessThan(terrainAtlasEdgeTexels(slots, TERRAIN_CHANNEL_SLOT_EDGE));
      seen.add(`${origin.u}:${origin.v}`);
    }
    expect(seen.size).toBe(slots);
    expect(() => terrainSlotOrigin(slots, slots, TERRAIN_CHANNEL_SLOT_EDGE)).toThrow(RangeError);
  });

  // Assertion 70c, the per-stage half.
  it("keeps the per-stage sampled-binding count under the declared limit", () => {
    const cap = REQUIRED_WEBGPU_LIMITS.maxSampledTexturesPerShaderStage!;
    expect(new Set(TERRAIN_SAMPLED_BINDINGS.fragment).size)
      .toBe(TERRAIN_SAMPLED_BINDINGS.fragment.length);
    expect(TERRAIN_SAMPLED_BINDINGS.fragment.length).toBeLessThanOrEqual(cap);
    expect(TERRAIN_SAMPLED_BINDINGS.vertex.length).toBeLessThanOrEqual(cap);
  });

  // Assertion 70b.
  it("blends season buckets cyclically across all 365 days", () => {
    let previous: { lo: number; hi: number; t: number } | null = null;
    for (let day = 0; day < 365; day += 0.25) {
      const blend = seasonBucketBlend(day);
      expect(blend.lo).toBeGreaterThanOrEqual(0);
      expect(blend.lo).toBeLessThan(SEASON_BUCKETS);
      expect(blend.hi).toBe((blend.lo + 1) % SEASON_BUCKETS);
      expect(blend.t).toBeGreaterThanOrEqual(0);
      expect(blend.t).toBeLessThan(1);
      if (previous) {
        // The blended position on the cyclic axis must be continuous: a naive
        // linear `lo + 1` asks for bucket 24 in late December.
        const step = ((blend.lo + blend.t) - (previous.lo + previous.t) + SEASON_BUCKETS)
          % SEASON_BUCKETS;
        expect(step).toBeLessThan(0.5);
      }
      previous = blend;
    }
    // 31 Dec -> 1 Jan, across the wrap.
    const december = seasonBucketBlend(364.99);
    const january = seasonBucketBlend(0);
    expect(december.lo).toBe(23);
    expect(december.hi).toBe(0);
    expect(january.lo).toBe(23);
    expect(january.hi).toBe(0);
    expect(Math.abs(january.t - december.t)).toBeLessThan(0.02);

    expect(seasonBucket(0)).toBe(0);
    expect(seasonBucket(364.9)).toBe(SEASON_BUCKETS - 1);
    expect(seasonBucket(-1)).toBe(SEASON_BUCKETS - 1);
    for (let bucket = 0; bucket < SEASON_BUCKETS; bucket += 1) {
      expect(seasonBucket(seasonBucketCenterDay(bucket))).toBe(bucket);
    }
  });

  it("names exactly one season-keyed channel family", () => {
    const keyed = TERRAIN_CHANNEL_FAMILIES.filter((family) => family.seasonKeyed);
    expect(keyed.map((family) => family.name)).toEqual(["splat"]);
    expect(terrainHeightBytesPerTexel()).toBe(4);
    // occlusion 4 + horizon 8 + splat 8 × 2 resident buckets.
    expect(terrainChannelBytesPerTexel()).toBe(28);
    expect(terrainChannelBytesPerTexel(1)).toBe(20);
  });

  // Assertion 69.
  it("moves the atlas MiB rows when their inputs move", () => {
    const profile = TIER_PROFILES[1]!;
    const base = estimateGpuMemoryBreakdown(profile, REFERENCE_VIEWPORT);

    // Derived, not copied: the row is edge² × bytes exactly.
    const heightEdge = terrainAtlasEdgeTexels(profile.heightAtlasSlots, TERRAIN_HEIGHT_SLOT_EDGE);
    expect(base.heightAtlasMiB).toBeCloseTo(
      (heightEdge * heightEdge * terrainHeightBytesPerTexel()) / 1_048_576,
      6,
    );
    const channelEdge =
      terrainAtlasEdgeTexels(profile.channelAtlasSlots, TERRAIN_CHANNEL_SLOT_EDGE);
    expect(base.channelAtlasMiB).toBeCloseTo(
      (channelEdge * channelEdge * terrainChannelBytesPerTexel()) / 1_048_576,
      6,
    );
    expect(base.heightPyramidMiB).toBeCloseTo(
      (TERRAIN_HEIGHT_PYRAMID_EDGE * TERRAIN_HEIGHT_PYRAMID_EDGE * 4) / 1_048_576,
      6,
    );

    // The profile knob moves the row.
    const wider = estimateGpuMemoryBreakdown(
      { ...profile, heightAtlasSlots: 256, channelAtlasSlots: 256 },
      REFERENCE_VIEWPORT,
    );
    expect(wider.heightAtlasMiB).toBeGreaterThan(base.heightAtlasMiB);
    expect(wider.channelAtlasMiB).toBeGreaterThan(base.channelAtlasMiB);

    // And so does SEASON_BUCKETS_RESIDENT: the splat family is counted twice.
    const oneBucket: DynamicAllocationInputs = {
      ...DYNAMIC_ALLOCATIONS,
      residentSeasonBuckets: 1,
    };
    const single = estimateGpuMemoryBreakdown(profile, REFERENCE_VIEWPORT, oneBucket);
    expect(single.channelAtlasMiB).toBeLessThan(base.channelAtlasMiB);
    expect(base.channelAtlasMiB - single.channelAtlasMiB).toBeCloseTo(
      (channelEdge * channelEdge * DYNAMIC_ALLOCATIONS.channelSeasonBytesPerTexel) / 1_048_576,
      6,
    );
  });

  it("pins the estimator's atlas shape against the contract", () => {
    // core/ keeps its no-subsystem-imports shape, so the shape is DECLARED in
    // PerformanceBudget and pinned here instead of imported (the same rule
    // `materialArrayLayers` follows).
    expect(DYNAMIC_ALLOCATIONS.heightSlotStoredEdge).toBe(TERRAIN_HEIGHT_SLOT_EDGE);
    expect(DYNAMIC_ALLOCATIONS.channelSlotStoredEdge).toBe(TERRAIN_CHANNEL_SLOT_EDGE);
    expect(DYNAMIC_ALLOCATIONS.heightSlotBytesPerTexel).toBe(terrainHeightBytesPerTexel());
    expect(DYNAMIC_ALLOCATIONS.residentSeasonBuckets).toBe(SEASON_BUCKETS_RESIDENT);
    expect(
      DYNAMIC_ALLOCATIONS.channelInvariantBytesPerTexel
      + DYNAMIC_ALLOCATIONS.channelSeasonBytesPerTexel * SEASON_BUCKETS_RESIDENT,
    ).toBe(terrainChannelBytesPerTexel());
    expect(DYNAMIC_ALLOCATIONS.heightPyramidEdge).toBe(TERRAIN_HEIGHT_PYRAMID_EDGE);
    expect(TERRAIN_HEIGHT_PYRAMID_SPAN_METERS).toBe(131_072);
  });

  it("keeps the CDLOD tier knobs monotone", () => {
    for (let index = 1; index < TIER_PROFILES.length; index += 1) {
      const lower = TIER_PROFILES[index - 1]!;
      const higher = TIER_PROFILES[index]!;
      expect(higher.cdlodPixelThreshold).toBeLessThanOrEqual(lower.cdlodPixelThreshold);
      expect(higher.cdlodNodeBudget).toBeGreaterThanOrEqual(lower.cdlodNodeBudget);
      expect(higher.heightAtlasSlots).toBeGreaterThanOrEqual(lower.heightAtlasSlots);
      expect(higher.finestResidentLevel).toBeLessThanOrEqual(lower.finestResidentLevel);
    }
    // Node budget exceeds slot budget by construction: one slot serves 8×8
    // nodes, so the two are not in 1:1 correspondence and never were.
    for (const profile of TIER_PROFILES) {
      expect(profile.cdlodNodeBudget).toBeGreaterThan(profile.heightAtlasSlots * 0.5);
    }
  });

  it("excludes L0 from supersampling and from band-limiting", () => {
    expect(terrainSupersampleOffsets(0)).toHaveLength(1);
    expect(terrainSupersampleOffsets(0)[0]).toEqual([0, 0]);
    expect(terrainSupersampleOffsets(1)).toHaveLength(4);
    // filterWidth 0 at L0 makes `filtering` false inside the kernel, so the
    // L0 page is bit-identical to the physics path by construction.
    expect(terrainPageFilterWidthMeters(0)).toBe(0);
    expect(terrainPageFilterWidthMeters(3)).toBe(terrainTexelSizeMeters(3));
  });

  it("pads readback rows to the 256-byte alignment", () => {
    // A 264-texel r32float row is 1,056 B and pads to 1,280.
    expect(terrainReadbackBytesPerRow(264, 4)).toBe(1_280);
    expect(terrainReadbackBytesPerRow(64, 4)).toBe(256);
  });
});
