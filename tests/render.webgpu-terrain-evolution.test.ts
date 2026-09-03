import { describe, expect, it } from "vitest";
import {
  EROSION_FIXED_ITERATION_COUNTS,
  EROSION_HALO_TEXELS,
  EROSION_MAX_OPERATOR_REACH_TEXELS,
  EROSION_PRODUCTION_SCRATCH_EDGE_TEXELS,
  TERRAIN_EROSION_PRODUCTION_CONFIG,
  TerrainErosionCompute,
  createErosionProtectionMask,
  erodeTerrainPage,
  erosionOverlapIsBitExact,
  fingerprintTerrainErosion,
} from "../src/render/webgpu/terrain/TerrainErosionCompute";
import {
  MACRO_EVOLUTION_PRODUCTION_CONFIG,
  TerrainMacroEvolution,
  computeMfdFlowAccumulation,
  evolveMacroTerrain,
  fingerprintEvolutionFields,
  finishMacroEvolutionFromEvolvedHeight,
  priorityFloodOpenRim,
  type MacroBaseLevelExport,
  type MacroEvolutionResult,
  type MacroLakeExport,
} from "../src/render/webgpu/terrain/TerrainMacroEvolution";

function enclosedBasin(width = 9, height = 9): Float32Array {
  const field = new Float32Array(width * height);
  for (let z = 0; z < height; z += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = z * width + x;
      if (x === 0 || z === 0 || x === width - 1 || z === height - 1) {
        field[index] = 0;
      } else if (x === 1 || z === 1 || x === width - 2 || z === height - 2) {
        // One deterministic low saddle at the north-west side of the rim.
        field[index] = x === 1 && z === 2 ? 10 : 14;
      } else {
        field[index] = 2 + Math.abs(x - 4) * 0.1 + Math.abs(z - 4) * 0.1;
      }
    }
  }
  return field;
}

function followReceiverToOpenRim(
  start: number,
  receivers: ArrayLike<number>,
  width: number,
  height: number,
): boolean {
  const seen = new Set<number>();
  let index = start;
  while (!seen.has(index)) {
    seen.add(index);
    const x = index % width;
    const z = Math.floor(index / width);
    if (x === 0 || z === 0 || x === width - 1 || z === height - 1) return true;
    const receiver = receivers[index] ?? -1;
    if (receiver < 0) return false;
    index = receiver;
  }
  return false;
}

function fixturePage(
  coreSize: number,
  haloTexels: number,
  originX: number,
  originZ: number,
): { heights: Float32Array; parentFlowAccumulation: Float32Array } {
  const edge = coreSize + haloTexels * 2;
  const heights = new Float32Array(edge * edge);
  const parentFlowAccumulation = new Float32Array(edge * edge);
  for (let z = 0; z < edge; z += 1) {
    for (let x = 0; x < edge; x += 1) {
      const worldX = originX + x - haloTexels;
      const worldZ = originZ + z - haloTexels;
      const index = z * edge + x;
      // A globally evaluated, gently sloping field. Talus is deliberately
      // inactive, while stream power remains live for the seam test.
      heights[index] = Math.fround(800 - worldX * 0.08 - worldZ * 0.03);
      parentFlowAccumulation[index] = Math.fround(
        64 + ((worldX * 13 + worldZ * 7) & 15) * 0.125,
      );
    }
  }
  return { heights, parentFlowAccumulation };
}

describe("Phase 5 deterministic landscape evolution", () => {
  it("priority-fills an enclosed basin and exports a legal open-rim drainage graph", () => {
    const width = 9;
    const height = 9;
    const result = evolveMacroTerrain({
      width,
      height,
      texelSizeMeters: 10,
      seaLevel: -20,
      heights: enclosedBasin(width, height),
      config: {
        streamPowerIterations: 0,
        streamPowerCoefficient: 0,
        talusIterations: 0,
        minimumLakeDepthMeters: 0.001,
        channelInitiationAreaTexels: 2,
      },
    });

    expect(result.lakes.length).toBeGreaterThan(0);
    for (const lake of result.lakes) {
      expect(lake.spillElevationMeters).toBe(result.filledHeight[lake.outletIndex]);
      expect(lake.maxDepthMeters).toBeGreaterThan(0);
      if (lake.outletReceiverIndex >= 0) {
        expect(result.lakeMask[lake.outletReceiverIndex]).not.toBe(lake.id);
      }
    }
    for (let index = 0; index < width * height; index += 1) {
      expect(followReceiverToOpenRim(index, result.receivers, width, height), `${index}`)
        .toBe(true);
      const receiver = result.receivers[index]!;
      if (receiver >= 0) {
        expect(result.filledHeight[receiver]!, `${index} -> ${receiver}`)
          .toBeLessThan(result.filledHeight[index]!);
      }
    }
    expect(result.baseLevels.length).toBeGreaterThan(0);
    expect(result.channelSeeds.length).toBeGreaterThan(0);
  });

  it("regenerates macro and page fields bit-for-bit", () => {
    const macro = new TerrainMacroEvolution({
      streamPowerIterations: 3,
      talusIterations: 3,
      channelInitiationAreaTexels: 3,
    });
    const input = {
      width: 9,
      height: 9,
      texelSizeMeters: 8,
      seaLevel: -20,
      heights: enclosedBasin(),
    } as const;
    const firstMacro = macro.evolve(input);
    const secondMacro = macro.evolve(input);
    const macroFields = (result: typeof firstMacro) => [
      result.evolvedHeight,
      result.filledHeight,
      result.receivers,
      result.flowAccumulation,
      result.lakeDepth,
      result.lakeMask,
      result.basinIds,
      result.channelSeeds,
    ] as const;
    expect(fingerprintEvolutionFields(macroFields(firstMacro)))
      .toBe(fingerprintEvolutionFields(macroFields(secondMacro)));
    expect(Array.from(firstMacro.evolvedHeight)).toEqual(Array.from(secondMacro.evolvedHeight));

    const coreSize = 8;
    const haloTexels = 4;
    const pageFixture = fixturePage(coreSize, haloTexels, 73, -21);
    const page = new TerrainErosionCompute({
      pitBreachRadiusTexels: 2,
      streamPowerIterations: 3,
      talusIterations: 4,
    });
    const firstPage = page.erode({
      coreSize,
      haloTexels,
      texelSizeMeters: 2,
      ...pageFixture,
    });
    const secondPage = page.erode({
      coreSize,
      haloTexels,
      texelSizeMeters: 2,
      ...pageFixture,
    });
    expect(fingerprintTerrainErosion(firstPage)).toBe(fingerprintTerrainErosion(secondPage));
    expect(Array.from(firstPage.evolvedHeight)).toEqual(Array.from(secondPage.evolvedHeight));
  });

  it("is bit-identical over adjacent stored overlaps with the production halo", () => {
    const coreSize = 8;
    const left = fixturePage(coreSize, EROSION_HALO_TEXELS, 0, 0);
    const right = fixturePage(coreSize, EROSION_HALO_TEXELS, coreSize, 0);
    const below = fixturePage(coreSize, EROSION_HALO_TEXELS, 0, coreSize);
    const first = erodeTerrainPage({
      coreSize,
      texelSizeMeters: 2,
      ...left,
    });
    const second = erodeTerrainPage({
      coreSize,
      texelSizeMeters: 2,
      ...right,
    });
    const third = erodeTerrainPage({
      coreSize,
      texelSizeMeters: 2,
      ...below,
    });
    expect(erosionOverlapIsBitExact(first, second, "horizontal")).toBe(true);
    expect(erosionOverlapIsBitExact(first, third, "vertical")).toBe(true);
  });

  it("keeps iteration/halo configuration world-constant and tier-independent", () => {
    expect(EROSION_HALO_TEXELS).toBe(64);
    expect(EROSION_PRODUCTION_SCRATCH_EDGE_TEXELS).toBe(384);
    expect(EROSION_MAX_OPERATOR_REACH_TEXELS).toBeLessThan(EROSION_HALO_TEXELS);
    expect(EROSION_FIXED_ITERATION_COUNTS).toEqual({
      pitBreachRadiusTexels: 16,
      streamPower: 24,
      talus: 32,
    });
    expect(Object.keys(TERRAIN_EROSION_PRODUCTION_CONFIG)).not.toContain("tier");
    expect(Object.keys(MACRO_EVOLUTION_PRODUCTION_CONFIG)).not.toContain("tier");
    expect(Object.isFrozen(TERRAIN_EROSION_PRODUCTION_CONFIG)).toBe(true);
    expect(Object.isFrozen(MACRO_EVOLUTION_PRODUCTION_CONFIG)).toBe(true);
  });

  it("protects runway earthworks exactly and accepts a perimeter-drain receiver hook", () => {
    const coreSize = 6;
    const haloTexels = 2;
    const edge = coreSize + haloTexels * 2;
    const source = new Float32Array(edge * edge);
    for (let z = 0; z < edge; z += 1) {
      for (let x = 0; x < edge; x += 1) {
        source[z * edge + x] = 120 - x * 2.5 + (z === 5 ? 7 : 0);
      }
    }
    const mask = createErosionProtectionMask({
      edge,
      worldOriginX: -5,
      worldOriginZ: -5,
      texelSizeMeters: 1,
      sourceHeight: source,
      sample: (worldX, worldZ) => Math.abs(worldX) <= 1 && Math.abs(worldZ) <= 1,
    });
    const overrideSource = 2 * edge + 2;
    const overrideTarget = overrideSource + 1;
    const overrides = new Int32Array(edge * edge);
    overrides.fill(-1);
    overrides[overrideSource] = overrideTarget;
    const result = erodeTerrainPage({
      coreSize,
      haloTexels,
      texelSizeMeters: 1,
      heights: source,
      erosionMask: mask,
      receiverOverrides: overrides,
      config: {
        pitBreachRadiusTexels: 1,
        streamPowerIterations: 2,
        streamPowerCoefficient: 0.2,
        talusIterations: 2,
        defaultReposeDegrees: 10,
      },
    });

    let unprotectedChangeCount = 0;
    for (let index = 0; index < source.length; index += 1) {
      if (mask[index]) {
        expect(result.evolvedHeight[index], `protected ${index}`).toBe(source[index]);
      } else if (result.evolvedHeight[index] !== source[index]) {
        unprotectedChangeCount += 1;
      }
      if (!mask[index] && result.receivers[index]! >= 0) {
        expect(mask[result.receivers[index]!], `receiver from ${index} enters earthworks`).toBe(0);
      }
    }
    expect(unprotectedChangeCount).toBeGreaterThan(0);
    expect(result.receivers[overrideSource]).toBe(overrideTarget);
  });
});

// ---------------------------------------------------------------------------
// W-1c (Phase 6, Gate W) bit-preservation harness.
//
// W-1c replaces containers and dispatch inside TerrainMacroEvolution (typed
// priority-flood heap, radix ordering for the MFD gather, stamp-array basin
// tracing) without touching any floating-point expression. The pinned
// fingerprints below are the contract that proves it: they were produced by
// the PRE-OPTIMIZATION implementation (branch jazonshou/Phase-6-Implementation
// at commit 98d87c4) by running this very file with an empty expectation
// object and copying vitest's reported actual values in verbatim. Any change
// to these numbers means the optimization stopped being bit-preserving; they
// must never be "refreshed" to make a run go green.
//
// The fixtures deliberately cover the three places a reordering could hide:
//   * `eroded` — varied multi-octave relief with sea, lakes and spatial
//     erodibility/repose fields, at the production iteration counts.
//   * `plateau` — enormous blocks of EXACTLY duplicate heights (a flat rim
//     band, a flat plateau and a flat enclosed basin) so a tie-breaking
//     regression in the flood heap or the MFD ordering cannot stay invisible.
//   * `runway` — a receiverExclusionMask plus receiverOverrides, the two MFD
//     branches evolveMacroTerrain itself never reaches.
// ---------------------------------------------------------------------------

function macroHash(x: number, z: number, salt: number): number {
  let h = Math.imul(x | 0, 374761393) + Math.imul(z | 0, 668265263) + Math.imul(salt | 0, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function smoothHash(x: number, z: number, period: number, salt: number): number {
  const gx = Math.floor(x / period);
  const gz = Math.floor(z / period);
  const fx = x / period - gx;
  const fz = z / period - gz;
  const ex = fx * fx * (3 - 2 * fx);
  const ez = fz * fz * (3 - 2 * fz);
  const n00 = macroHash(gx, gz, salt);
  const n10 = macroHash(gx + 1, gz, salt);
  const n01 = macroHash(gx, gz + 1, salt);
  const n11 = macroHash(gx + 1, gz + 1, salt);
  const top = n00 + (n10 - n00) * ex;
  const bottom = n01 + (n11 - n01) * ex;
  return top + (bottom - top) * ez;
}

function erodedFixture(edge: number): {
  heights: Float32Array;
  erodibility: Float32Array;
  reposeDegrees: Float32Array;
} {
  const heights = new Float32Array(edge * edge);
  const erodibility = new Float32Array(edge * edge);
  const reposeDegrees = new Float32Array(edge * edge);
  for (let z = 0; z < edge; z += 1) {
    for (let x = 0; x < edge; x += 1) {
      const index = z * edge + x;
      const relief = smoothHash(x, z, 37, 1) * 900
        + smoothHash(x, z, 13, 2) * 260
        + smoothHash(x, z, 5, 3) * 70;
      // A west-side shelf keeps the submerged/protected branches live.
      const shelf = Math.min(1, x / 26);
      heights[index] = Math.fround(relief * shelf - 140);
      erodibility[index] = Math.fround(0.4 + smoothHash(x, z, 19, 4) * 1.2);
      reposeDegrees[index] = Math.fround(28 + smoothHash(x, z, 23, 5) * 14);
    }
  }
  return { heights, erodibility, reposeDegrees };
}

function plateauBasinFixture(edge: number): Float32Array {
  const field = new Float32Array(edge * edge);
  for (let z = 0; z < edge; z += 1) {
    for (let x = 0; x < edge; x += 1) {
      let value = 100;
      if (x === 0 || z === 0 || x === edge - 1 || z === edge - 1) value = 0;
      else if (x < 6 || z < 6 || x >= edge - 6 || z >= edge - 6) value = 60;
      else if (x >= 28 && x < 84 && z >= 28 && z < 84) value = 20;
      if (x === 3 && z === 40) value = 35;
      field[z * edge + x] = value;
    }
  }
  return field;
}

/** A low channel-initiation area so the flat fixture still exports seeds. */
function plateauInput(edge: number) {
  return {
    width: edge,
    height: edge,
    texelSizeMeters: 512,
    seaLevel: 5,
    heights: plateauBasinFixture(edge),
    config: { channelInitiationAreaTexels: 8 },
  } as const;
}

function fingerprintLakes(lakes: readonly MacroLakeExport[]): number {
  const packed = new Float64Array(lakes.length * 7);
  let at = 0;
  for (const lake of lakes) {
    packed[at] = lake.id;
    packed[at + 1] = lake.outletIndex;
    packed[at + 2] = lake.outletReceiverIndex;
    packed[at + 3] = lake.spillElevationMeters;
    packed[at + 4] = lake.maxDepthMeters;
    packed[at + 5] = lake.surfaceAreaM2;
    packed[at + 6] = lake.texelCount;
    at += 7;
  }
  return fingerprintEvolutionFields([packed]);
}

function fingerprintBaseLevels(baseLevels: readonly MacroBaseLevelExport[]): number {
  const packed = new Float64Array(baseLevels.length * 3);
  let at = 0;
  for (const baseLevel of baseLevels) {
    packed[at] = baseLevel.id;
    packed[at + 1] = baseLevel.outletIndex;
    packed[at + 2] = baseLevel.elevationMeters;
    at += 3;
  }
  return fingerprintEvolutionFields([packed]);
}

function fingerprintMacroResult(prefix: string, result: MacroEvolutionResult): Record<string, number> {
  return {
    [`${prefix}.evolvedHeight`]: fingerprintEvolutionFields([result.evolvedHeight]),
    [`${prefix}.filledHeight`]: fingerprintEvolutionFields([result.filledHeight]),
    [`${prefix}.receivers`]: fingerprintEvolutionFields([result.receivers]),
    [`${prefix}.flowAccumulation`]: fingerprintEvolutionFields([result.flowAccumulation]),
    [`${prefix}.lakeDepth`]: fingerprintEvolutionFields([result.lakeDepth]),
    [`${prefix}.lakeMask`]: fingerprintEvolutionFields([result.lakeMask]),
    [`${prefix}.basinIds`]: fingerprintEvolutionFields([result.basinIds]),
    [`${prefix}.channelSeeds`]: fingerprintEvolutionFields([result.channelSeeds]),
    [`${prefix}.lakes`]: fingerprintLakes(result.lakes),
    [`${prefix}.baseLevels`]: fingerprintBaseLevels(result.baseLevels),
    [`${prefix}.lakeCount`]: result.lakes.length,
    [`${prefix}.baseLevelCount`]: result.baseLevels.length,
    [`${prefix}.channelSeedCount`]: result.channelSeeds.length,
  };
}

/** Sloped page with a protected runway strip and a perimeter-ditch override. */
function runwayFixture(edge: number): {
  heights: Float32Array;
  initialAccumulation: Float32Array;
  exclusion: Uint8Array;
  overrides: Int32Array;
} {
  const count = edge * edge;
  const heights = new Float32Array(count);
  const initialAccumulation = new Float32Array(count);
  const exclusion = new Uint8Array(count);
  const overrides = new Int32Array(count);
  overrides.fill(-1);
  for (let z = 0; z < edge; z += 1) {
    for (let x = 0; x < edge; x += 1) {
      const index = z * edge + x;
      // Gentle regional slope plus a flat graded platform, so the excluded
      // strip sits on real ties rather than on a synthetic gradient.
      const graded = x >= 18 && x < 46 && z >= 26 && z < 34;
      heights[index] = Math.fround(
        graded ? 240 : 300 - x * 1.25 - z * 0.5 + smoothHash(x, z, 9, 6) * 12,
      );
      initialAccumulation[index] = Math.fround(1 + ((x * 7 + z * 11) & 7) * 0.25);
      if (x >= 20 && x < 44 && z >= 28 && z < 32) exclusion[index] = 1;
    }
  }
  // A deterministic ditch immediately south of the strip: each ditch cell is
  // forced to route one texel east into the next unexcluded ditch cell.
  for (let x = 20; x < 43; x += 1) {
    const index = 33 * edge + x;
    overrides[index] = index + 1;
  }
  return { heights, initialAccumulation, exclusion, overrides };
}

describe("W-1c: optimized paths are bit-identical to the reference", () => {
  // Derived from the pre-optimization implementation (commit 98d87c4) as
  // described in the header comment above. Do not regenerate.
  const PINNED: Record<string, number> = {
    "eroded.evolvedHeight": 1403609570,
    "eroded.filledHeight": 350686641,
    "eroded.receivers": 3321617762,
    "eroded.flowAccumulation": 2384387415,
    "eroded.lakeDepth": 3750527235,
    "eroded.lakeMask": 15182679,
    "eroded.basinIds": 1885050697,
    "eroded.channelSeeds": 1997911454,
    "eroded.lakes": 3341915567,
    "eroded.baseLevels": 1141457644,
    "eroded.lakeCount": 27,
    "eroded.baseLevelCount": 508,
    "eroded.channelSeedCount": 611,
    "plateau.evolvedHeight": 868686305,
    "plateau.filledHeight": 163171999,
    "plateau.receivers": 1612281469,
    "plateau.flowAccumulation": 3372100530,
    "plateau.lakeDepth": 2093585158,
    "plateau.lakeMask": 3404392757,
    "plateau.basinIds": 2338625831,
    "plateau.channelSeeds": 516007274,
    "plateau.lakes": 2163878291,
    "plateau.baseLevels": 2470238328,
    "plateau.lakeCount": 2,
    "plateau.baseLevelCount": 508,
    "plateau.channelSeedCount": 12490,
    "runway.filledHeight": 944456172,
    "runway.floodParent": 3928848551,
    "runway.settlementOrder": 1617687625,
    "runway.receivers": 45142096,
    "runway.flowAccumulation": 3444068986,
  };

  it("reproduces the pinned macro fingerprints for eroded relief and flat ties", () => {
    const edge = 128;
    const eroded = erodedFixture(edge);
    const erodedResult = evolveMacroTerrain({
      width: edge,
      height: edge,
      texelSizeMeters: 512,
      seaLevel: 0,
      heights: eroded.heights,
      erodibility: eroded.erodibility,
      reposeDegrees: eroded.reposeDegrees,
    });
    const plateauResult = evolveMacroTerrain(plateauInput(edge));
    const runway = runwayFixture(64);
    const flood = priorityFloodOpenRim(
      64,
      64,
      runway.heights,
      12,
      MACRO_EVOLUTION_PRODUCTION_CONFIG.fillEpsilonMetersPerTexel,
    );
    const flow = computeMfdFlowAccumulation(64, 64, flood.filledHeight, flood.floodParent, {
      slopeExponent: MACRO_EVOLUTION_PRODUCTION_CONFIG.mfdSlopeExponent,
      initialAccumulation: runway.initialAccumulation,
      receiverExclusionMask: runway.exclusion,
      receiverOverrides: runway.overrides,
    });

    const actual: Record<string, number> = {
      ...fingerprintMacroResult("eroded", erodedResult),
      ...fingerprintMacroResult("plateau", plateauResult),
      "runway.filledHeight": fingerprintEvolutionFields([flood.filledHeight]),
      "runway.floodParent": fingerprintEvolutionFields([flood.floodParent]),
      "runway.settlementOrder": fingerprintEvolutionFields([flood.settlementOrder]),
      "runway.receivers": fingerprintEvolutionFields([flow.receivers]),
      "runway.flowAccumulation": fingerprintEvolutionFields([flow.flowAccumulation]),
    };
    expect(actual).toEqual(PINNED);

    // The plateau fixture only earns its keep if the flats really are flats.
    expect(plateauResult.lakes.length).toBeGreaterThan(0);
    // The runway fixture only earns its keep if both MFD branches fired.
    expect(flow.receivers[33 * 64 + 30]).toBe(33 * 64 + 31);
    for (let index = 0; index < 64 * 64; index += 1) {
      if (runway.exclusion[index] === 1) continue;
      const receiver = flow.receivers[index]!;
      if (receiver >= 0) expect(runway.exclusion[receiver], `${index} -> ${receiver}`).toBe(0);
    }
  });

  // -------------------------------------------------------------------------
  // The hybrid GPU path finishes a surface the GPU already eroded. It used to
  // spell that as `evolveMacroTerrain` with zero stream-power/talus iterations,
  // which ran the priority flood and the MFD gather TWICE over identical data
  // and discarded the first pair. `finishMacroEvolutionFromEvolvedHeight` is
  // the same work with the dead pair removed; these tests are the proof that
  // "the same work" is meant bit-for-bit, including the `Math.fround` the
  // zero-iteration operators applied at their f32 boundary.
  // -------------------------------------------------------------------------
  const ZERO_ITERATIONS = { streamPowerIterations: 0, talusIterations: 0 } as const;

  function expectSameMacroResult(
    reference: MacroEvolutionResult,
    candidate: MacroEvolutionResult,
  ): void {
    expect(Array.from(candidate.evolvedHeight)).toEqual(Array.from(reference.evolvedHeight));
    expect(Array.from(candidate.filledHeight)).toEqual(Array.from(reference.filledHeight));
    expect(Array.from(candidate.receivers)).toEqual(Array.from(reference.receivers));
    expect(Array.from(candidate.flowAccumulation)).toEqual(Array.from(reference.flowAccumulation));
    expect(Array.from(candidate.lakeDepth)).toEqual(Array.from(reference.lakeDepth));
    expect(Array.from(candidate.lakeMask)).toEqual(Array.from(reference.lakeMask));
    expect(Array.from(candidate.basinIds)).toEqual(Array.from(reference.basinIds));
    expect(Array.from(candidate.channelSeeds)).toEqual(Array.from(reference.channelSeeds));
    expect(candidate.lakes).toEqual(reference.lakes);
    expect(candidate.baseLevels).toEqual(reference.baseLevels);
    expect(candidate.config).toEqual(reference.config);
    // Fingerprints as well as toEqual: toEqual on a Float32Array read through
    // Array.from would not distinguish two NaN payloads, the byte hash does.
    expect(fingerprintMacroResult("x", candidate)).toEqual(fingerprintMacroResult("x", reference));
  }

  it("finishes a GPU-evolved surface exactly as the zero-iteration path does", () => {
    const edge = 128;
    const eroded = erodedFixture(edge);
    const grid = {
      width: edge,
      height: edge,
      texelSizeMeters: 512,
      seaLevel: 0,
    } as const;

    // A float32 surface: the production hybrid case.
    const f32Input = { ...grid, heights: eroded.heights, config: ZERO_ITERATIONS };
    const f32Reference = evolveMacroTerrain(f32Input);
    const f32Candidate = finishMacroEvolutionFromEvolvedHeight(f32Input);
    expectSameMacroResult(f32Reference, f32Candidate);
    expect(f32Reference.lakes.length).toBeGreaterThan(0);
    expect(f32Reference.channelSeeds.length).toBeGreaterThan(0);

    // Verified, not assumed: at zero iterations the operators leave a float32
    // surface bit-for-bit alone, so the finished height is the supplied one.
    expect(new Uint32Array(f32Candidate.evolvedHeight.buffer))
      .toEqual(new Uint32Array(eroded.heights.buffer));

    // A surface a float32 CANNOT hold: the zero-iteration operators round it at
    // their f32 boundary, so the completion path has to round it too. This is
    // the fixture that fails if the rounding is dropped as "an identity".
    const wide = Float64Array.from(eroded.heights, (value, index) =>
      value + (index % 11) * 1e-9 + 3e-9);
    expect(Array.from(wide).some((value) => Math.fround(value) !== value)).toBe(true);
    const wideInput = { ...grid, heights: wide, config: ZERO_ITERATIONS };
    expectSameMacroResult(evolveMacroTerrain(wideInput), finishMacroEvolutionFromEvolvedHeight(wideInput));

    // And the flat fixture, where the ties are dense.
    const flat = { ...plateauInput(edge), config: ZERO_ITERATIONS };
    expectSameMacroResult(evolveMacroTerrain(flat), finishMacroEvolutionFromEvolvedHeight(flat));
  });

  it("pins the exact substitution the hybrid stage-2 runtime made", () => {
    // `completeTerrainMacroEvolutionFromEvolvedHeight` used to build this
    // object and call `.evolveExport`; it now calls
    // `finishMacroEvolutionFromEvolvedHeight` and exports that. The export
    // wrapper is a pure function of the result and rejects anything but the
    // 1024² production domain, so the substitution is pinned here at the
    // result level and end-to-end at production size by W-1a's
    // tests/render.webgpu-terrain-macro-hybrid.test.ts.
    const edge = 96;
    const eroded = erodedFixture(edge);
    const grid = {
      width: edge,
      height: edge,
      texelSizeMeters: 512,
      seaLevel: 0,
      heights: eroded.heights,
    } as const;
    const previous = new TerrainMacroEvolution(ZERO_ITERATIONS).evolve(grid);
    const current = finishMacroEvolutionFromEvolvedHeight({ ...grid, config: ZERO_ITERATIONS });
    expectSameMacroResult(previous, current);
    expect(previous.lakes.length).toBeGreaterThan(0);
    expect(previous.channelSeeds.length).toBeGreaterThan(0);
  });

  it("does not change evolveMacroTerrain when it shares the completion half", () => {
    // The refactor that extracted the shared tail must leave the real
    // production entry point alone; the pinned fingerprints above already
    // cover that, and this keeps the intent explicit for anyone editing it.
    const edge = 96;
    const eroded = erodedFixture(edge);
    const input = {
      width: edge,
      height: edge,
      texelSizeMeters: 512,
      seaLevel: 0,
      heights: eroded.heights,
      erodibility: eroded.erodibility,
      reposeDegrees: eroded.reposeDegrees,
    } as const;
    const result = evolveMacroTerrain(input);
    // Full production iteration counts really did run: the surface moved.
    expect(Array.from(result.evolvedHeight)).not.toEqual(Array.from(eroded.heights));
    expect(result.config.streamPowerIterations)
      .toBe(MACRO_EVOLUTION_PRODUCTION_CONFIG.streamPowerIterations);
    expect(result.config.talusIterations).toBe(MACRO_EVOLUTION_PRODUCTION_CONFIG.talusIterations);
    // And the completion path is NOT a substitute for it.
    const finished = finishMacroEvolutionFromEvolvedHeight(input);
    expect(Array.from(finished.evolvedHeight)).toEqual(Array.from(eroded.heights));
  });

  it("returns identical arrays across repeated evaluations of the flat fixture", () => {
    const input = plateauInput(128);
    const first = evolveMacroTerrain(input);
    const second = evolveMacroTerrain(input);
    expect(Array.from(first.evolvedHeight)).toEqual(Array.from(second.evolvedHeight));
    expect(Array.from(first.filledHeight)).toEqual(Array.from(second.filledHeight));
    expect(Array.from(first.receivers)).toEqual(Array.from(second.receivers));
    expect(Array.from(first.flowAccumulation)).toEqual(Array.from(second.flowAccumulation));
    expect(Array.from(first.basinIds)).toEqual(Array.from(second.basinIds));
    expect(Array.from(first.lakeMask)).toEqual(Array.from(second.lakeMask));
    expect(Array.from(first.channelSeeds)).toEqual(Array.from(second.channelSeeds));
    expect(first.lakes).toEqual(second.lakes);
    expect(first.baseLevels).toEqual(second.baseLevels);
  });
});
