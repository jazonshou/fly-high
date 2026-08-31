import {
  getAirportInfluence,
  sampleFilteredTerrainHeight,
  sampleFilteredTerrainUpliftHeight,
  sampleTerrainEvolutionGeology,
  sampleTerrainFineBandRelief,
  sampleTerrainUpliftHeight,
  type WorldDefinition,
} from "@/src/world";
import {
  WORLD_PAGE_GUTTER,
  WORLD_PAGE_BASE_EXTENT_METERS,
  WORLD_PAGE_HEIGHT_CORE,
  coreToStoredIndex,
  storedEdge,
} from "@/src/render/webgpu/world/pageGeometry";
import {
  createWorldPageAddress,
  worldPageBounds,
  type WorldPageAddress,
} from "@/src/render/webgpu/world/pageKey";
import {
  EVOLUTION_DOMAIN_SAMPLE_COUNT,
  EVOLUTION_TEXEL_METERS,
  TERRAIN_EVOLUTION_CONTRACT_VERSION,
  TERRAIN_EVOLUTION_MACRO_LAYOUT,
  terrainEvolutionMacroBlend,
  type TerrainMacroEvolutionExport,
} from "./TerrainEvolutionContract";
import { computeMfdFlowAccumulation } from "./TerrainMacroEvolution";
import {
  EROSION_HALO_TEXELS,
  EROSION_PRODUCTION_SCRATCH_EDGE_TEXELS,
  TerrainErosionCompute,
  extractStoredErosionHeight,
  resolveTerrainErosionConfig,
  type TerrainErosionConfig,
  type TerrainErosionResult,
} from "./TerrainErosionCompute";
import {
  terrainPageFilterWidthMeters,
  terrainSupersampleOffsets,
  terrainTexelSizeMeters,
} from "./TerrainSpineContract";
import {
  buildTerrainMacroLakeField,
  buildTerrainPageHydrology,
  type TerrainMacroLakeField,
  type TerrainPageHydrologyResult,
} from "./TerrainPageHydrology";

/** Worker-owned structural equivalent of the atlas slot statistics contract. */
export interface TerrainErodedPageStats {
  readonly minHeightMeters: number;
  readonly maxHeightMeters: number;
  readonly maxDeviationFromParent: number;
}

/** The transferable final product of the asynchronous Phase 5 page DAG. */
export interface TerrainErodedPage {
  readonly address: WorldPageAddress;
  readonly coreSize: number;
  readonly haloTexels: number;
  readonly scratchEdge: number;
  readonly storedEdge: number;
  /** Core plus the canonical four-texel page gutter, row-major. */
  readonly storedHeight: Float32Array;
  readonly stats: TerrainErodedPageStats;
  readonly protectedSampleCount: number;
  /** Null only for small pure-erosion fixtures and explicit analytic parity. */
  readonly hydrology: TerrainPageHydrologyResult | null;
}

export interface TerrainErosionPageBuildInput {
  readonly address: WorldPageAddress;
  readonly coreSize: number;
  readonly haloTexels: number;
  readonly texelSizeMeters: number;
  readonly sourceHeight: ArrayLike<number>;
  readonly erosionMask?: ArrayLike<number>;
  readonly parentFlowAccumulation?: ArrayLike<number>;
  /** Deterministic adjacent perimeter-ditch routing, -1 where unconstrained. */
  readonly receiverOverrides?: ArrayLike<number>;
  readonly erodibility?: ArrayLike<number>;
  readonly reposeDegrees?: ArrayLike<number>;
  /** 0 keeps the seeded source field, 1 keeps the locally evolved result. */
  readonly evolutionBlend?: ArrayLike<number>;
  /** `W-4`: post-erosion fine-band relief in metres. */
  readonly fineBandRelief?: ArrayLike<number>;
  /** Prepared macro lake authority; enables the Phase-5 auxiliary product. */
  readonly macroLakes?: TerrainMacroLakeField;
  readonly config?: Partial<TerrainErosionConfig>;
}

export interface TerrainMacroEvolutionSample {
  readonly heightMeters: number;
  readonly flowAccumulationAreaM2: number;
}

type TerrainSupersampleOffset = readonly [number, number];

function validateMacroEvolution(macro: Readonly<TerrainMacroEvolutionExport>): void {
  if (macro.contractVersion !== TERRAIN_EVOLUTION_CONTRACT_VERSION) {
    throw new RangeError("Macro evolution contract version mismatch");
  }
  if (
    macro.heightMeters.length !== EVOLUTION_DOMAIN_SAMPLE_COUNT
    || macro.flowAccumulationAreaM2.length !== EVOLUTION_DOMAIN_SAMPLE_COUNT
  ) {
    throw new RangeError("Macro evolution fields do not match the canonical 1024² layout");
  }
}

function sampleTerrainMacroEvolutionUnchecked(
  macro: Readonly<TerrainMacroEvolutionExport>,
  worldX: number,
  worldZ: number,
): TerrainMacroEvolutionSample {
  const edge = TERRAIN_EVOLUTION_MACRO_LAYOUT.texelsPerEdge;
  const sampleAxis = (world: number, minimum: number): readonly [number, number, number] => {
    const coordinate = (world - minimum) / EVOLUTION_TEXEL_METERS - 0.5;
    const first = Math.max(0, Math.min(edge - 1, Math.floor(coordinate)));
    const second = Math.max(0, Math.min(edge - 1, first + 1));
    return [first, second, Math.max(0, Math.min(1, coordinate - first))];
  };
  const [x0, x1, tx] = sampleAxis(worldX, TERRAIN_EVOLUTION_MACRO_LAYOUT.minWorldX);
  const [z0, z1, tz] = sampleAxis(worldZ, TERRAIN_EVOLUTION_MACRO_LAYOUT.minWorldZ);
  const interpolate = (field: ArrayLike<number>): number => {
    const top = field[z0 * edge + x0]! * (1 - tx) + field[z0 * edge + x1]! * tx;
    const bottom = field[z1 * edge + x0]! * (1 - tx) + field[z1 * edge + x1]! * tx;
    return top * (1 - tz) + bottom * tz;
  };
  return {
    heightMeters: interpolate(macro.heightMeters),
    flowAccumulationAreaM2: Math.max(0, interpolate(macro.flowAccumulationAreaM2)),
  };
}

/** Bilinear sample of the canonical cell-centred macro authority. */
export function sampleTerrainMacroEvolution(
  macro: Readonly<TerrainMacroEvolutionExport>,
  worldX: number,
  worldZ: number,
): TerrainMacroEvolutionSample {
  validateMacroEvolution(macro);
  return sampleTerrainMacroEvolutionUnchecked(macro, worldX, worldZ);
}

function sampleTerrainErosionSourceHeightWithLayout(
  world: Readonly<WorldDefinition>,
  worldX: number,
  worldZ: number,
  texelSizeMeters: number,
  filterWidthMeters: number,
  offsets: readonly TerrainSupersampleOffset[],
): number {
  let total = 0;
  for (const [offsetX, offsetZ] of offsets) {
    total += sampleFilteredTerrainUpliftHeight(
      world,
      worldX + offsetX * texelSizeMeters,
      worldZ + offsetZ * texelSizeMeters,
      filterWidthMeters,
    );
  }
  return Math.fround(total / offsets.length);
}

function sampleTerrainAnalyticHeightWithLayout(
  world: Readonly<WorldDefinition>,
  worldX: number,
  worldZ: number,
  texelSizeMeters: number,
  filterWidthMeters: number,
  offsets: readonly TerrainSupersampleOffset[],
): number {
  let total = 0;
  for (const [offsetX, offsetZ] of offsets) {
    total += sampleFilteredTerrainHeight(
      world,
      worldX + offsetX * texelSizeMeters,
      worldZ + offsetZ * texelSizeMeters,
      filterWidthMeters,
    );
  }
  return Math.fround(total / offsets.length);
}

function sampleTerrainFineBandReliefWithLayout(
  seedHash: number,
  worldX: number,
  worldZ: number,
  texelSizeMeters: number,
  filterWidthMeters: number,
  offsets: readonly TerrainSupersampleOffset[],
): number {
  let total = 0;
  for (const [offsetX, offsetZ] of offsets) {
    total += sampleTerrainFineBandRelief(
      seedHash,
      worldX + offsetX * texelSizeMeters,
      worldZ + offsetZ * texelSizeMeters,
      filterWidthMeters,
    );
  }
  return Math.fround(total / offsets.length);
}

/**
 * The analytic/uplift sample consumed by the reference page pass. It mirrors
 * the existing GPU page kernel: L0 is one full-bandwidth sample and coarser
 * levels are the same fixed four-sample, level-band-limited pattern.
 */
export function sampleTerrainErosionSourceHeight(
  world: Readonly<WorldDefinition>,
  address: WorldPageAddress,
  worldX: number,
  worldZ: number,
): number {
  const texelSizeMeters = terrainTexelSizeMeters(address.level);
  const filterWidthMeters = terrainPageFilterWidthMeters(address.level);
  const offsets = terrainSupersampleOffsets(address.level);
  return sampleTerrainErosionSourceHeightWithLayout(
    world,
    worldX,
    worldZ,
    texelSizeMeters,
    filterWidthMeters,
    offsets,
  );
}

/** The runway/apron and its authored earthworks batter are erosion-invariant. */
export function isTerrainErosionProtected(
  world: Readonly<WorldDefinition>,
  worldX: number,
  worldZ: number,
): boolean {
  return world.airport !== null
    && getAirportInfluence(world.airport, worldX, worldZ) > 0;
}

/**
 * Measure the same min/max and second-difference quantity the analytic GPU
 * generator writes. Measurements cover the stored core+gutter rectangle;
 * the 64-texel scratch halo supplies the one-sample apron.
 */
export function measureTerrainErosionResultStats(
  result: TerrainErosionResult,
  gutter = WORLD_PAGE_GUTTER,
): TerrainErodedPageStats {
  if (gutter < 0 || !Number.isSafeInteger(gutter) || gutter >= result.haloTexels) {
    throw new RangeError("Terrain erosion stats gutter must fit inside the scratch halo");
  }
  let minimum = Number.POSITIVE_INFINITY;
  let maximum = Number.NEGATIVE_INFINITY;
  let maximumDeviation = 0;
  for (let row = -gutter; row < result.coreSize + gutter; row += 1) {
    for (let column = -gutter; column < result.coreSize + gutter; column += 1) {
      const index = (row + result.haloTexels) * result.scratchEdge
        + column + result.haloTexels;
      const height = result.evolvedHeight[index]!;
      minimum = Math.min(minimum, height);
      maximum = Math.max(maximum, height);
      const dx = Math.abs(height - 0.5 * (
        result.evolvedHeight[index - 1]! + result.evolvedHeight[index + 1]!
      ));
      const dz = Math.abs(height - 0.5 * (
        result.evolvedHeight[index - result.scratchEdge]!
        + result.evolvedHeight[index + result.scratchEdge]!
      ));
      maximumDeviation = Math.max(maximumDeviation, dx, dz);
    }
  }
  return Object.freeze({
    minHeightMeters: Math.fround(minimum),
    maxHeightMeters: Math.fround(maximum),
    maxDeviationFromParent: Math.fround(maximumDeviation),
  });
}

/**
 * The finishing half of the page DAG, split out of {@link buildTerrainErodedPage}
 * so the multi-frame GPU producer (`W-1d`) can hand externally computed evolved
 * fields to the SAME finalization code the CPU path runs: evolution blend,
 * protected-count, stored extraction, stats and the hydrology product. The
 * `erosion.evolvedHeight` field is mutated in place by the blend, exactly as
 * before the split.
 */
export interface TerrainErodedPageFinishInput {
  readonly address: WorldPageAddress;
  readonly coreSize: number;
  readonly haloTexels: number;
  readonly sourceHeight: ArrayLike<number>;
  readonly evolutionBlend?: ArrayLike<number>;
  readonly macroLakes?: TerrainMacroLakeField;
  readonly erosion: TerrainErosionResult;
}

export function finishTerrainErodedPage(
  input: TerrainErodedPageFinishInput,
): TerrainErodedPage {
  const result = input.erosion;
  if (input.sourceHeight.length !== result.evolvedHeight.length) {
    throw new RangeError("Terrain eroded page source height length mismatch");
  }
  if (input.evolutionBlend) {
    if (input.evolutionBlend.length !== result.evolvedHeight.length) {
      throw new RangeError("Terrain evolution blend length mismatch");
    }
    for (let index = 0; index < result.evolvedHeight.length; index += 1) {
      const blend = input.evolutionBlend[index]!;
      if (!Number.isFinite(blend) || blend < 0 || blend > 1) {
        throw new RangeError(`Terrain evolution blend[${index}] must be in [0, 1]`);
      }
      result.evolvedHeight[index] = Math.fround(
        input.sourceHeight[index]!
        + (result.evolvedHeight[index]! - input.sourceHeight[index]!) * blend,
      );
    }
  }
  let protectedSampleCount = 0;
  for (const value of result.erosionMask) protectedSampleCount += value === 0 ? 0 : 1;
  const finalStoredEdge = storedEdge(input.coreSize, WORLD_PAGE_GUTTER);
  // This must run before `result` and its 384-square scratch fields leave the
  // worker stack. Reconstructing flow/soil from the 264-square height payload
  // would silently replace the converged erosion authority with a proxy.
  const hydrology = input.macroLakes
    ? buildTerrainPageHydrology({
      address: input.address,
      erosion: result,
      macroLakes: input.macroLakes,
      channelCoreSize: input.coreSize / 2,
      gutter: WORLD_PAGE_GUTTER,
    })
    : null;
  return Object.freeze({
    address: input.address,
    coreSize: input.coreSize,
    haloTexels: input.haloTexels,
    scratchEdge: result.scratchEdge,
    storedEdge: finalStoredEdge,
    storedHeight: extractStoredErosionHeight(result),
    stats: measureTerrainErosionResultStats(result),
    protectedSampleCount,
    hydrology,
  });
}

/** Pure finalization seam used by the worker and small deterministic tests. */
export function buildTerrainErodedPage(
  input: TerrainErosionPageBuildInput,
): TerrainErodedPage {
  const erosion = new TerrainErosionCompute(input.config);
  const result = erosion.erode({
    coreSize: input.coreSize,
    haloTexels: input.haloTexels,
    texelSizeMeters: input.texelSizeMeters,
    heights: input.sourceHeight,
    ...(input.erosionMask ? { erosionMask: input.erosionMask } : {}),
    ...(input.parentFlowAccumulation
      ? { parentFlowAccumulation: input.parentFlowAccumulation }
      : {}),
    ...(input.receiverOverrides ? { receiverOverrides: input.receiverOverrides } : {}),
    ...(input.erodibility ? { erodibility: input.erodibility } : {}),
    ...(input.reposeDegrees ? { reposeDegrees: input.reposeDegrees } : {}),
    ...(input.fineBandRelief ? { fineBandRelief: input.fineBandRelief } : {}),
  });
  return finishTerrainErodedPage({
    address: input.address,
    coreSize: input.coreSize,
    haloTexels: input.haloTexels,
    sourceHeight: input.sourceHeight,
    ...(input.evolutionBlend ? { evolutionBlend: input.evolutionBlend } : {}),
    ...(input.macroLakes ? { macroLakes: input.macroLakes } : {}),
    erosion: result,
  });
}

const PERIMETER_NEIGHBOURS = Object.freeze([
  [-1, -1], [0, -1], [1, -1],
  [-1, 0],             [1, 0],
  [-1, 1],  [0, 1],   [1, 1],
] as const);

/**
 * Route the one-texel unprotected ring around authored earthworks along its
 * local downhill tangent. Strict descent makes the overrides acyclic; local
 * minima remain unconstrained so the ordinary breach/MFD path can leave the
 * ring instead of manufacturing an uphill cycle.
 */
export function buildTerrainPerimeterDrainReceiverOverrides(
  erosionMask: ArrayLike<number>,
  sourceHeight: ArrayLike<number>,
  edge: number,
): Int32Array {
  if (!Number.isSafeInteger(edge) || edge <= 0) {
    throw new RangeError("Terrain perimeter-drain edge must be a positive integer");
  }
  const count = edge * edge;
  if (erosionMask.length !== count || sourceHeight.length !== count) {
    throw new RangeError("Terrain perimeter-drain field length mismatch");
  }
  const perimeter = new Uint8Array(count);
  for (let index = 0; index < count; index += 1) {
    if ((erosionMask[index] ?? 0) >= 0.5) continue;
    const x = index % edge;
    const z = Math.floor(index / edge);
    for (const [dx, dz] of PERIMETER_NEIGHBOURS) {
      const nx = x + dx;
      const nz = z + dz;
      if (nx < 0 || nz < 0 || nx >= edge || nz >= edge) continue;
      if ((erosionMask[nz * edge + nx] ?? 0) >= 0.5) {
        perimeter[index] = 1;
        break;
      }
    }
  }
  const overrides = new Int32Array(count);
  overrides.fill(-1);
  for (let index = 0; index < count; index += 1) {
    if (!perimeter[index]) continue;
    const source = Number(sourceHeight[index]);
    if (!Number.isFinite(source)) {
      throw new RangeError(`Terrain perimeter-drain height[${index}] must be finite`);
    }
    const x = index % edge;
    const z = Math.floor(index / edge);
    let receiver = -1;
    let receiverHeight = source;
    for (const [dx, dz] of PERIMETER_NEIGHBOURS) {
      const nx = x + dx;
      const nz = z + dz;
      if (nx < 0 || nz < 0 || nx >= edge || nz >= edge) continue;
      const neighbour = nz * edge + nx;
      if (!perimeter[neighbour]) continue;
      const height = Number(sourceHeight[neighbour]);
      if (!Number.isFinite(height)) {
        throw new RangeError(`Terrain perimeter-drain height[${neighbour}] must be finite`);
      }
      if (height < receiverHeight || (height === receiverHeight && neighbour < receiver)) {
        receiver = neighbour;
        receiverHeight = height;
      }
    }
    if (receiver >= 0 && receiverHeight < source) overrides[index] = receiver;
  }
  return overrides;
}

/** The seven per-texel fields the production 384² seed loop composes. */
export interface TerrainErosionSeedFields {
  readonly scratchEdge: number;
  readonly texelSizeMeters: number;
  readonly sourceHeight: Float32Array;
  readonly erosionMask: Uint8Array;
  readonly parentFlowAccumulation: Float32Array;
  readonly evolutionBlend: Float32Array;
  readonly erodibility: Float32Array;
  readonly reposeDegrees: Float32Array;
  /** `W-4`: post-erosion fine-band relief in metres (never an uplift input). */
  readonly fineBandRelief: Float32Array;
}

/**
 * The production C-2 seeding composition (macro-target blend, geology,
 * airport mask), extracted verbatim from the reference page path so the GPU
 * producer's WGSL twin and its tests can name the exact CPU semantics.
 * `generateTerrainErodedPage` composes THIS — the split cannot change bytes,
 * and the pinned fingerprints in tests/render.webgpu-erosion-staged.test.ts
 * hold it to that.
 */
export function buildTerrainErosionSeedFields(
  world: Readonly<WorldDefinition>,
  macro: Readonly<TerrainMacroEvolutionExport>,
  address: WorldPageAddress,
): TerrainErosionSeedFields {
  const coreSize = WORLD_PAGE_HEIGHT_CORE;
  const haloTexels = EROSION_HALO_TEXELS;
  const scratchEdge = coreSize + haloTexels * 2;
  if (scratchEdge !== EROSION_PRODUCTION_SCRATCH_EDGE_TEXELS) {
    throw new Error("Production terrain erosion scratch must remain 384 texels");
  }
  const texelSizeMeters = terrainTexelSizeMeters(address.level);
  const filterWidthMeters = terrainPageFilterWidthMeters(address.level);
  const supersampleOffsets = terrainSupersampleOffsets(address.level);
  const pageBounds = worldPageBounds(address, WORLD_PAGE_BASE_EXTENT_METERS);
  const scratchOriginX = pageBounds.minX - haloTexels * texelSizeMeters;
  const scratchOriginZ = pageBounds.minZ - haloTexels * texelSizeMeters;
  const sourceHeight = new Float32Array(scratchEdge * scratchEdge);
  const erosionMask = new Uint8Array(sourceHeight.length);
  const parentFlowAccumulation = new Float32Array(sourceHeight.length);
  const evolutionBlend = new Float32Array(sourceHeight.length);
  const erodibility = new Float32Array(sourceHeight.length);
  const reposeDegrees = new Float32Array(sourceHeight.length);
  const fineBandRelief = new Float32Array(sourceHeight.length);
  const geologyTarget = {
    fabricCos2: 1,
    fabricSin2: 0,
    erodibility: 1,
    reposeDegrees: 34,
  };
  for (let row = 0; row < scratchEdge; row += 1) {
    const worldZ = scratchOriginZ + row * texelSizeMeters;
    for (let column = 0; column < scratchEdge; column += 1) {
      const worldX = scratchOriginX + column * texelSizeMeters;
      const index = row * scratchEdge + column;
      const uplift = sampleTerrainErosionSourceHeightWithLayout(
        world,
        worldX,
        worldZ,
        texelSizeMeters,
        filterWidthMeters,
        supersampleOffsets,
      );
      const analytic = sampleTerrainAnalyticHeightWithLayout(
        world,
        worldX,
        worldZ,
        texelSizeMeters,
        filterWidthMeters,
        supersampleOffsets,
      );
      const macroSample = sampleTerrainMacroEvolutionUnchecked(macro, worldX, worldZ);
      // Preserve detail below the macro's 512 m lattice by adding the macro's
      // eroded displacement to the page's own band-limited uplift sample.
      const macroUplift = sampleTerrainUpliftHeight(
        world.seedHash,
        worldX,
        worldZ,
        EVOLUTION_TEXEL_METERS,
      );
      const blend = terrainEvolutionMacroBlend(worldX, worldZ);
      const protectedSample = isTerrainErosionProtected(world, worldX, worldZ);
      erosionMask[index] = protectedSample ? 1 : 0;
      const macroTarget = uplift + macroSample.heightMeters - macroUplift;
      // D2 is a compatibility blend, not just a macro-displacement mask. At
      // blend=0 the complete historical analytic kernel survives exactly;
      // the local erosion delta is multiplied by the same blend below.
      sourceHeight[index] = protectedSample
        ? analytic
        : Math.fround(analytic + (macroTarget - analytic) * blend);
      parentFlowAccumulation[index] = Math.fround(Math.max(
        1,
        macroSample.flowAccumulationAreaM2 / (texelSizeMeters * texelSizeMeters),
      ));
      evolutionBlend[index] = protectedSample ? 0 : blend;
      const geology = sampleTerrainEvolutionGeology(
        world.seedHash,
        worldX,
        worldZ,
        filterWidthMeters,
        geologyTarget,
      );
      erodibility[index] = Math.fround(geology.erodibility);
      reposeDegrees[index] = Math.fround(geology.reposeDegrees);
      // W-4: the band VALUE is composed here, beside the other seeded material
      // fields, and consumed after the operators. Supersampled with the same
      // level pattern as the height samples so a coarse page's band is the
      // blurred version of the fine one rather than a re-rolled phase.
      fineBandRelief[index] = sampleTerrainFineBandReliefWithLayout(
        world.seedHash,
        worldX,
        worldZ,
        texelSizeMeters,
        filterWidthMeters,
        supersampleOffsets,
      );
    }
  }
  return {
    scratchEdge,
    texelSizeMeters,
    sourceHeight,
    erosionMask,
    parentFlowAccumulation,
    evolutionBlend,
    erodibility,
    reposeDegrees,
    fineBandRelief,
  };
}

/**
 * Production CPU-reference page path. It is deliberately worker-safe: no
 * Babylon imports, DOM state, quality tier, frame clock, or admission inputs.
 */
export function generateTerrainErodedPage(
  world: Readonly<WorldDefinition>,
  macro: Readonly<TerrainMacroEvolutionExport>,
  address: WorldPageAddress,
  preparedMacroLakes: TerrainMacroLakeField = buildTerrainMacroLakeField(macro),
): TerrainErodedPage {
  validateMacroEvolution(macro);
  if (macro.provenance.worldSeed !== world.seed) {
    throw new RangeError("Macro evolution seed does not match the requested world");
  }
  const seed = buildTerrainErosionSeedFields(world, macro, address);
  const receiverOverrides = world.airport
    ? buildTerrainPerimeterDrainReceiverOverrides(
      seed.erosionMask,
      seed.sourceHeight,
      seed.scratchEdge,
    )
    : null;
  return buildTerrainErodedPage({
    address,
    coreSize: WORLD_PAGE_HEIGHT_CORE,
    haloTexels: EROSION_HALO_TEXELS,
    texelSizeMeters: seed.texelSizeMeters,
    sourceHeight: seed.sourceHeight,
    erosionMask: seed.erosionMask,
    parentFlowAccumulation: seed.parentFlowAccumulation,
    ...(receiverOverrides ? { receiverOverrides } : {}),
    evolutionBlend: seed.evolutionBlend,
    erodibility: seed.erodibility,
    reposeDegrees: seed.reposeDegrees,
    fineBandRelief: seed.fineBandRelief,
    macroLakes: preparedMacroLakes,
  });
}

// ---------------------------------------------------------------------------
// `W-1d` staged page DAG — the CPU halves of the multi-frame GPU producer.
//
// The GPU DAG runs SEED/BREACH/stream-power/talus on the device and round-trips
// through the erosion worker twice: once for the deterministic MFD receiver
// pass (order-dependent by construction — it stays the unchanged CPU code) and
// once for finalization (blend, stats, hydrology — the unchanged CPU code via
// finishTerrainErodedPage). These helpers are worker-safe and shared verbatim
// by terrainErosion.worker.ts and the inline no-Worker fallback, so the staged
// path exists exactly once.
// ---------------------------------------------------------------------------

/**
 * How a page's 384² sourceHeight seed composes (`W-2`):
 * - "macro": today's C-2 composition against the canonical macro export —
 *   the chain's termination at the coarsest page level.
 * - "parent": resident level+1 converged pages supply upsampled stored
 *   heights and channel-atlas flow; only the GPU seed pass reads them.
 */
export type TerrainErosionSeedMode = "macro" | "parent";

/**
 * `W-2`: the highest page level whose seed composes from RESIDENT level+1
 * pages instead of the canonical macro export.
 *
 * The rule is a pure function of level and NEVER of residency timing: a page's
 * bytes may not depend on what happened to be resident when it was scheduled
 * (assertion 89 regenerates the same address and demands byte equality). The
 * admission gate is what makes the level rule satisfiable — a parent-seeded
 * page is not admitted until its whole seed block is resident.
 *
 * Shipping at ZERO (only L0 pages chain, from their L1 parents), which is a
 * DEVIATION from the spec's "every level chains to level 9" wording, taken for
 * a measured residency reason: each extra chained level adds its own 2x2 seed
 * block per page to the required-resident set, and the union over the 5x5 L0
 * collision ring reaches ~25 pages at level 1 alone and does not shrink much
 * per level. A nine-deep chain therefore wants ~100 extra simultaneously
 * resident height AND channel slots against a 144/100-slot tier-1 atlas — it
 * would deadlock streaming, not converge it. Depth one puts the chain exactly
 * where the authority matters (L0 is the collision and near-ground surface)
 * and leaves the mechanism general: raise this constant when the atlas can pay
 * for it. Levels above it terminate the chain on the macro composition.
 */
export const TERRAIN_EROSION_PARENT_SEEDED_MAX_LEVEL = 0;

/** Whether a page at `level` seeds from converged parents or from the macro. */
export function terrainErosionSeedModeForLevel(
  level: number,
  parentSeededMaxLevel = TERRAIN_EROSION_PARENT_SEEDED_MAX_LEVEL,
): TerrainErosionSeedMode {
  return level <= parentSeededMaxLevel ? "parent" : "macro";
}

/**
 * The 2x2 block of level+1 pages whose stored CORES cover a child's 384²
 * scratch support.
 *
 * The 64-child-texel halo is 32 parent texels — far past the parent's own
 * 4-texel stored gutter — so the seed pass resolves every tap to the parent
 * page whose core OWNS that world texel rather than to a gutter copy. Per axis
 * the support `[childOffset - 32, childOffset + 160]` crosses exactly one
 * parent-page boundary, on the side the child sits against, so two pages per
 * axis always suffice.
 */
export function terrainErosionParentSeedBlock(
  address: WorldPageAddress,
): readonly WorldPageAddress[] {
  const parentX = Math.floor(address.x / 2);
  const parentZ = Math.floor(address.z / 2);
  const stepX = address.x - parentX * 2 === 0 ? -1 : 1;
  const stepZ = address.z - parentZ * 2 === 0 ? -1 : 1;
  const level = address.level + 1;
  return Object.freeze([
    createWorldPageAddress(level, parentX, parentZ),
    createWorldPageAddress(level, parentX + stepX, parentZ),
    createWorldPageAddress(level, parentX, parentZ + stepZ),
    createWorldPageAddress(level, parentX + stepX, parentZ + stepZ),
  ]);
}

/**
 * Addresses that must be fully resident before `address` may be admitted.
 * Empty for macro-seeded levels, which is what terminates the chain and makes
 * the admission gate provably deadlock-free (a macro-seeded page is never
 * gated, and every parent-seeded page depends only on levels above it).
 */
export function terrainErosionAdmissionDependencies(
  address: WorldPageAddress,
  parentSeededMaxLevel = TERRAIN_EROSION_PARENT_SEEDED_MAX_LEVEL,
): readonly WorldPageAddress[] {
  return terrainErosionSeedModeForLevel(address.level, parentSeededMaxLevel) === "parent"
    ? terrainErosionParentSeedBlock(address)
    : [];
}

/** CPU-computed seed inputs the GPU seed pass cannot derive itself. */
export interface TerrainErosionSeedInputsStage {
  /** 384² airport-influence mask — bit-identical to the reference path's. */
  readonly erosionMask: Uint8Array;
  /**
   * Macro mode only: the bilinear macro height (f32-rounded). Null in parent
   * mode, where the GPU upsamples the resident parents' stored heights.
   */
  readonly macroHeight: Float32Array | null;
  /**
   * Macro mode only: the reference path's exact
   * `fround(max(1, areaM2 / texel²))` accumulation field, uploaded straight
   * into the producer's flow buffer. Null in parent mode, where the GPU
   * decodes it from the parent channel atlas's f16 log-flow field.
   */
  readonly macroFlow: Float32Array | null;
}

/** Stage 0 of the staged DAG: pure per-page CPU inputs, no retained state. */
export function prepareTerrainErosionSeedInputsStage(
  world: Readonly<WorldDefinition>,
  macro: Readonly<TerrainMacroEvolutionExport> | null,
  address: WorldPageAddress,
  seedMode: TerrainErosionSeedMode,
): TerrainErosionSeedInputsStage {
  const scratchEdge = EROSION_PRODUCTION_SCRATCH_EDGE_TEXELS;
  const haloTexels = EROSION_HALO_TEXELS;
  const texelSizeMeters = terrainTexelSizeMeters(address.level);
  const pageBounds = worldPageBounds(address, WORLD_PAGE_BASE_EXTENT_METERS);
  const scratchOriginX = pageBounds.minX - haloTexels * texelSizeMeters;
  const scratchOriginZ = pageBounds.minZ - haloTexels * texelSizeMeters;
  const count = scratchEdge * scratchEdge;
  const erosionMask = new Uint8Array(count);
  if (world.airport) {
    for (let row = 0; row < scratchEdge; row += 1) {
      const worldZ = scratchOriginZ + row * texelSizeMeters;
      for (let column = 0; column < scratchEdge; column += 1) {
        const worldX = scratchOriginX + column * texelSizeMeters;
        erosionMask[row * scratchEdge + column] =
          isTerrainErosionProtected(world, worldX, worldZ) ? 1 : 0;
      }
    }
  }
  let macroHeight: Float32Array | null = null;
  let macroFlow: Float32Array | null = null;
  if (seedMode === "macro") {
    if (!macro) throw new Error("Macro-seeded erosion requires the macro evolution export");
    validateMacroEvolution(macro);
    macroHeight = new Float32Array(count);
    macroFlow = new Float32Array(count);
    const texelArea = texelSizeMeters * texelSizeMeters;
    for (let row = 0; row < scratchEdge; row += 1) {
      const worldZ = scratchOriginZ + row * texelSizeMeters;
      for (let column = 0; column < scratchEdge; column += 1) {
        const worldX = scratchOriginX + column * texelSizeMeters;
        const sample = sampleTerrainMacroEvolutionUnchecked(macro, worldX, worldZ);
        const index = row * scratchEdge + column;
        macroHeight[index] = Math.fround(sample.heightMeters);
        macroFlow[index] = Math.fround(Math.max(1, sample.flowAccumulationAreaM2 / texelArea));
      }
    }
  }
  return { erosionMask, macroHeight, macroFlow };
}

/**
 * Inverse of the GPU producers' monotonic orderable-f32 encoding (the same
 * bijection TerrainPageAtlas's `decodeOrderableFloat` implements — pinned
 * against it by test). Restated here because the worker must stay Babylon-free.
 */
export function decodeOrderableFloatBits(bits: Uint32Array): Float32Array {
  const fault = terrainErosionOrderableReadbackFaultIndex(bits);
  if (fault >= 0) {
    throw new TerrainErosionReadbackFaultError(
      `orderable-encoded readback is invalid at index ${fault}: the encoding `
      + "never produces zero for a finite float, so the buffer did not land "
      + "(a GPU readback that raced its copy returns zeros, not data)",
    );
  }
  const decoded = new Uint32Array(bits.length);
  for (let index = 0; index < bits.length; index += 1) {
    const value = bits[index]!;
    decoded[index] = (value & 0x8000_0000) !== 0 ? value & 0x7fff_ffff : ~value >>> 0;
  }
  return new Float32Array(decoded.buffer);
}

/**
 * A readback that never landed, distinguished from bad data.
 *
 * Recoverable by construction: the GPU buffer still holds the result, so the
 * producer re-reads rather than failing the page.
 */
export class TerrainErosionReadbackFaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TerrainErosionReadbackFaultError";
  }
}

/**
 * Index of the first texel proving an orderable-encoded readback did not land,
 * or -1 when the buffer is legal.
 *
 * `pOrderableEncode` maps a POSITIVE float to `bits | 0x80000000` (high bit
 * always set) and a NEGATIVE one to `~bits` (zero only for the NaN payload
 * 0xFFFFFFFF). **Zero is therefore not a legal encoding of any finite float**,
 * which makes an all-zero buffer unambiguous evidence that the copy never
 * happened rather than plausible-looking data.
 *
 * Why this exists: without it, zero decodes to `~0 >>> 0` = 0xFFFFFFFF = NaN,
 * the NaN flows into the MFD stage, and the failure surfaces hundreds of lines
 * away as "drainageHeight[0] must be finite" — a message naming a symptom in a
 * different subsystem. That misdirection cost four separate Gate W and Wave
 * agents time before the mechanism was pinned down.
 */
export function terrainErosionOrderableReadbackFaultIndex(bits: Uint32Array): number {
  for (let index = 0; index < bits.length; index += 1) {
    if (bits[index] === 0) return index;
  }
  return -1;
}

/** GPU breach products crossing to the worker MFD stage. */
export interface TerrainErosionMfdStagePayload {
  readonly address: WorldPageAddress;
  /** 384² seed heights read back from the GPU seed pass. */
  readonly sourceHeight: Float32Array;
  /** 384² breach-carved surface, orderable-u32-encoded (atomicMin lanes). */
  readonly breachedHeightBits: Uint32Array;
  /** 384² breach receivers (-1 terminates). */
  readonly breachReceivers: Int32Array;
  /** 384² per-texel accumulation boundary condition (parent/macro flow). */
  readonly flowAccumulation: Float32Array;
  /** 384² protection mask, as uploaded to the GPU. */
  readonly erosionMask: Uint8Array;
}

/** What the MFD stage retains worker-side until the FINISH stage arrives. */
export interface TerrainErosionMfdStageResult {
  readonly breachedHeight: Float32Array;
  /** Deterministic receiver topology for the GPU stream-power passes. */
  readonly receivers: Int32Array;
}

/**
 * Stage MFD: the deterministic order-dependent receiver pass, unchanged CPU
 * code (radix-ordered `computeMfdFlowAccumulation`), with the reference path's
 * exact options: parent flow as initial accumulation, mask exclusion, and the
 * perimeter-ditch overrides rebuilt from the SAME mask + seed heights.
 * Per the verbatim rule the accumulation output is discarded — the parent
 * flow field IS the boundary condition — so only receivers return.
 */
export function runTerrainErosionMfdStage(
  world: Readonly<WorldDefinition>,
  payload: TerrainErosionMfdStagePayload,
  config: Readonly<TerrainErosionConfig> = resolveTerrainErosionConfig(undefined),
): TerrainErosionMfdStageResult {
  const scratchEdge = EROSION_PRODUCTION_SCRATCH_EDGE_TEXELS;
  const count = scratchEdge * scratchEdge;
  for (const [label, length] of [
    ["sourceHeight", payload.sourceHeight.length],
    ["breachedHeightBits", payload.breachedHeightBits.length],
    ["breachReceivers", payload.breachReceivers.length],
    ["flowAccumulation", payload.flowAccumulation.length],
    ["erosionMask", payload.erosionMask.length],
  ] as const) {
    if (length !== count) {
      throw new RangeError(`Terrain erosion MFD stage ${label} length mismatch`);
    }
  }
  const breachedHeight = decodeOrderableFloatBits(payload.breachedHeightBits);
  const receiverOverrides = world.airport
    ? buildTerrainPerimeterDrainReceiverOverrides(
      payload.erosionMask,
      payload.sourceHeight,
      scratchEdge,
    )
    : null;
  const flow = computeMfdFlowAccumulation(
    scratchEdge,
    scratchEdge,
    breachedHeight,
    payload.breachReceivers,
    {
      slopeExponent: config.mfdSlopeExponent,
      initialAccumulation: payload.flowAccumulation,
      receiverExclusionMask: payload.erosionMask,
      ...(receiverOverrides ? { receiverOverrides } : {}),
    },
  );
  return { breachedHeight, receivers: flow.receivers };
}

/**
 * Stage FINISH: assemble a normal TerrainErodedPage from the GPU's evolved
 * scratch. Masked cells are restored to the exact f32 seed bits (the same
 * belt-and-braces restore erodeTerrainPage performs), the evolution blend is
 * recomputed from the address (bit-identical to the seed loop's field: same
 * function, same f64 coordinates), and finalization is the SHARED
 * finishTerrainErodedPage — the one code path the CPU reference runs.
 */
export function finishTerrainErodedPageStage(
  input: {
    readonly address: WorldPageAddress;
    readonly sourceHeight: Float32Array;
    readonly breachedHeight: Float32Array;
    readonly receivers: Int32Array;
    readonly flowAccumulation: Float32Array;
    readonly erosionMask: Uint8Array;
    readonly evolvedHeight: Float32Array;
    readonly macroLakes: TerrainMacroLakeField | null;
    readonly config?: Readonly<TerrainErosionConfig>;
  },
): TerrainErodedPage {
  const scratchEdge = EROSION_PRODUCTION_SCRATCH_EDGE_TEXELS;
  const haloTexels = EROSION_HALO_TEXELS;
  const coreSize = WORLD_PAGE_HEIGHT_CORE;
  const count = scratchEdge * scratchEdge;
  for (const [label, length] of [
    ["sourceHeight", input.sourceHeight.length],
    ["breachedHeight", input.breachedHeight.length],
    ["receivers", input.receivers.length],
    ["flowAccumulation", input.flowAccumulation.length],
    ["erosionMask", input.erosionMask.length],
    ["evolvedHeight", input.evolvedHeight.length],
  ] as const) {
    if (length !== count) {
      throw new RangeError(`Terrain erosion finish stage ${label} length mismatch`);
    }
  }
  const texelSizeMeters = terrainTexelSizeMeters(input.address.level);
  const pageBounds = worldPageBounds(input.address, WORLD_PAGE_BASE_EXTENT_METERS);
  const scratchOriginX = pageBounds.minX - haloTexels * texelSizeMeters;
  const scratchOriginZ = pageBounds.minZ - haloTexels * texelSizeMeters;
  // The finisher mutates evolvedHeight in place; never alias the caller's copy.
  const evolvedHeight = Float32Array.from(input.evolvedHeight);
  const mask = new Uint8Array(count);
  const evolutionBlend = new Float32Array(count);
  for (let row = 0; row < scratchEdge; row += 1) {
    const worldZ = scratchOriginZ + row * texelSizeMeters;
    for (let column = 0; column < scratchEdge; column += 1) {
      const index = row * scratchEdge + column;
      const isProtected = (input.erosionMask[index] ?? 0) >= 0.5;
      mask[index] = isProtected ? 1 : 0;
      if (isProtected) {
        // Authored pavement carries the exact Float32 seed representation.
        evolvedHeight[index] = Math.fround(input.sourceHeight[index]!);
        evolutionBlend[index] = 0;
      } else {
        const worldX = scratchOriginX + column * texelSizeMeters;
        evolutionBlend[index] = terrainEvolutionMacroBlend(worldX, worldZ);
      }
    }
  }
  const erosion: TerrainErosionResult = Object.freeze({
    coreSize,
    haloTexels,
    scratchEdge,
    texelSizeMeters,
    evolvedHeight,
    drainageHeight: input.breachedHeight,
    receivers: input.receivers,
    flowAccumulation: input.flowAccumulation,
    erosionMask: mask,
    config: input.config ?? resolveTerrainErosionConfig(undefined),
  });
  return finishTerrainErodedPage({
    address: input.address,
    coreSize,
    haloTexels,
    sourceHeight: input.sourceHeight,
    evolutionBlend,
    ...(input.macroLakes ? { macroLakes: input.macroLakes } : {}),
    erosion,
  });
}

/** Copy the collision core out of a transferred stored page without aliasing it. */
export function extractTerrainErodedCollisionCore(page: TerrainErodedPage): Float32Array {
  const core = new Float32Array(page.coreSize * page.coreSize);
  for (let row = 0; row < page.coreSize; row += 1) {
    for (let column = 0; column < page.coreSize; column += 1) {
      core[row * page.coreSize + column] = page.storedHeight[
        coreToStoredIndex(row, column, page.coreSize, WORLD_PAGE_GUTTER)
      ]!;
    }
  }
  return core;
}
