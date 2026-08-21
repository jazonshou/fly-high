import {
  getAirportInfluence,
  sampleFilteredTerrainHeight,
  sampleFilteredTerrainUpliftHeight,
  sampleTerrainEvolutionGeology,
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
import {
  EROSION_HALO_TEXELS,
  EROSION_PRODUCTION_SCRATCH_EDGE_TEXELS,
  TerrainErosionCompute,
  extractStoredErosionHeight,
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
  });
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
    }
  }
  const receiverOverrides = world.airport
    ? buildTerrainPerimeterDrainReceiverOverrides(erosionMask, sourceHeight, scratchEdge)
    : null;
  return buildTerrainErodedPage({
    address,
    coreSize,
    haloTexels,
    texelSizeMeters,
    sourceHeight,
    erosionMask,
    parentFlowAccumulation,
    ...(receiverOverrides ? { receiverOverrides } : {}),
    evolutionBlend,
    erodibility,
    reposeDegrees,
    macroLakes: preparedMacroLakes,
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
