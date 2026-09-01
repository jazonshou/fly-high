import { describe, expect, it } from "vitest";
import {
  AIRFIELD_ASPECT_V_START,
  AIRFIELD_CONCRETE_EDGE,
  AIRFIELD_METAL_EDGE,
  AIRFIELD_METAL_TILE_METERS,
  AIRFIELD_CONCRETE_TILE_METERS,
  synthesisByteSize,
  synthesizeAirfieldConcrete,
  synthesizeAirfieldMetal,
} from "@/src/render/webgpu/airfield/AirfieldMaterials";

/**
 * `7-11` — the airfield material synthesis, asserted on the ARTIFACT.
 *
 * Every assertion here reads the synthesized bytes, never the recipe's
 * intent: coverage floors fail if a feature is absent (the false-pass rule),
 * the gravity property fails if weathering stops growing downward (the
 * property the whole UV contract exists to deliver), and the budget is the
 * sum of the actual arrays rather than a number in prose (transcribed
 * figures went stale twice in one night on the draw-ceiling side).
 */

describe("7-11 airfield material synthesis", () => {
  const metal = synthesizeAirfieldMetal(0x7d11);
  const concrete = synthesizeAirfieldConcrete(0x7d11);

  it("is deterministic and seed-sensitive", () => {
    const again = synthesizeAirfieldMetal(0x7d11);
    expect(Buffer.from(again.albedoMips[0]!).equals(Buffer.from(metal.albedoMips[0]!))).toBe(true);
    const other = synthesizeAirfieldMetal(0x7d12);
    expect(Buffer.from(other.albedoMips[0]!).equals(Buffer.from(metal.albedoMips[0]!))).toBe(false);
  });

  it("carries every declared metal feature at a non-decorative coverage", () => {
    // Floors sized so an absent feature fails loudly and a texture-wide
    // feature fails too (a rust layer covering everything is not weathering,
    // it is a different material).
    expect(metal.featureCoverage.ribs).toBeGreaterThan(0.1);
    expect(metal.featureCoverage.seams).toBeGreaterThan(0.005);
    expect(metal.featureCoverage.seams).toBeLessThan(0.2);
    expect(metal.featureCoverage.bolts).toBeGreaterThan(0.001);
    expect(metal.featureCoverage.bolts).toBeLessThan(0.05);
    expect(metal.featureCoverage.streaks).toBeGreaterThan(0.02);
    expect(metal.featureCoverage.streaks).toBeLessThan(0.6);
    expect(metal.featureCoverage.oxidation).toBeGreaterThan(0.05);
    expect(metal.featureCoverage.oxidation).toBeLessThan(0.75);
  });

  it("carries every declared concrete feature at a non-decorative coverage", () => {
    expect(concrete.featureCoverage["form-ties"]).toBeGreaterThan(0.005);
    expect(concrete.featureCoverage["form-ties"]).toBeLessThan(0.2);
    expect(concrete.featureCoverage["board-seams"]).toBeGreaterThan(0.01);
    expect(concrete.featureCoverage["tie-streaks"]).toBeGreaterThan(0.01);
  });

  it("weathers DOWNWARD — the gravity property the UV contract depends on", () => {
    // The aspect-V-start trick only deepens weathering if weathering grows
    // with V. Assert the artifact, not the intent, on both surfaces.
    expect(metal.oxidationBottomThird).toBeGreaterThan(metal.oxidationTopThird * 2);
    expect(concrete.oxidationBottomThird).toBeGreaterThan(concrete.oxidationTopThird * 1.5);
    // And the aspect table itself must be monotone or the contract inverts.
    expect(AIRFIELD_ASPECT_V_START.facingRunway).toBeLessThan(AIRFIELD_ASPECT_V_START.sides);
    expect(AIRFIELD_ASPECT_V_START.sides).toBeLessThan(AIRFIELD_ASPECT_V_START.awayFromRunway);
    expect(AIRFIELD_ASPECT_V_START.awayFromRunway).toBeLessThan(0.5);
  });

  it("tiles in U: the structured features are exact-period and the seam column matches", () => {
    // Ribs and seams are built from exact divisors of the tile, so row
    // profiles at x=0 and x=edge must continue each other. Compare the
    // HEIGHT-driven normal's x-channel across the wrap on the top (least
    // weathered) rows: the wrapped central difference already encodes
    // continuity, so a seam would appear as an outlier band.
    const edge = metal.edge;
    const level = metal.normalMips[0]!;
    let seamDelta = 0;
    let interiorDelta = 0;
    for (let y = 0; y < edge; y += 1) {
      const rowStart = y * edge * 4;
      seamDelta += Math.abs(level[rowStart]! - level[rowStart + (edge - 1) * 4]!);
      interiorDelta += Math.abs(
        level[rowStart + Math.floor(edge / 2) * 4]!
        - level[rowStart + (Math.floor(edge / 2) - 1) * 4]!,
      );
    }
    // The wrap columns may differ no more, on average, than an arbitrary
    // interior pair — a visible seam shows up as a multiple, not a percent.
    expect(seamDelta).toBeLessThan(interiorDelta * 3 + edge * 8);
  });

  it("stays inside the declared memory arithmetic", () => {
    // The budget is the sum of the actual arrays. rgba8, full chains:
    // metal 3 x 256^2 x 4 x 4/3, concrete 3 x 128^2 x 4 x 4/3 — about
    // 1.31 MiB together. The ceiling here is deliberately ABOVE the ideal
    // sum (mip chains carry the +1/3 series plus rounding) and far below
    // the 7D headroom; growing either edge fails this before it fails the
    // inventory pin on a capture host.
    const totalBytes = synthesisByteSize(metal) + synthesisByteSize(concrete);
    const totalMiB = totalBytes / (1024 * 1024);
    expect(totalMiB).toBeGreaterThan(0.9);
    expect(totalMiB).toBeLessThan(1.45);
    expect(metal.edge).toBe(AIRFIELD_METAL_EDGE);
    expect(concrete.edge).toBe(AIRFIELD_CONCRETE_EDGE);
  });

  it("packs the aircraft-convention ORM map (R=AO, G=roughness, B=metallic)", () => {
    // Spot the packing rather than trusting the docblock: rusted texels are
    // rougher and less metallic than clean ones. Compare band means between
    // the clean top rows and the weathered bottom rows of the base mip.
    const edge = metal.edge;
    const orm = metal.metallicRoughnessMips[0]!;
    let topRoughness = 0;
    let bottomRoughness = 0;
    let topMetal = 0;
    let bottomMetal = 0;
    const rows = Math.floor(edge / 8);
    for (let y = 0; y < rows; y += 1) {
      for (let x = 0; x < edge; x += 1) {
        const top = (y * edge + x) * 4;
        const bottom = ((edge - 1 - y) * edge + x) * 4;
        topRoughness += orm[top + 1]!;
        bottomRoughness += orm[bottom + 1]!;
        topMetal += orm[top + 2]!;
        bottomMetal += orm[bottom + 2]!;
      }
    }
    expect(bottomRoughness).toBeGreaterThan(topRoughness * 1.1);
    expect(topMetal).toBeGreaterThan(bottomMetal * 1.1);
  });

  it("exports the tiling periods geometry must read instead of retyping", () => {
    expect(AIRFIELD_METAL_TILE_METERS).toBeGreaterThan(1);
    expect(AIRFIELD_CONCRETE_TILE_METERS).toBeGreaterThan(1);
  });
});
