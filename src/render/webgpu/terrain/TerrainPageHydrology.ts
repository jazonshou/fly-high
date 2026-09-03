import {
  EVOLUTION_DOMAIN_SAMPLE_COUNT,
  EVOLUTION_DOMAIN_TEXELS,
  EVOLUTION_TEXEL_METERS,
  TERRAIN_EVOLUTION_CONTRACT_VERSION,
  TERRAIN_EVOLUTION_MACRO_LAYOUT,
  TERRAIN_FLOW_ACCUMULATION_MAX_AREA_M2,
  TERRAIN_PAGE_HYDROLOGY_ENCODING,
  encodeTerrainFlowAccumulationLog2,
  terrainEvolutionMacroBlend,
  type TerrainMacroEvolutionExport,
  type TerrainEvolutionPageExport,
} from "./TerrainEvolutionContract";
import type { TerrainErosionResult } from "./TerrainErosionCompute";
import { smoothstep } from "@/src/world/noise";
import {
  WORLD_PAGE_BASE_EXTENT_METERS,
  WORLD_PAGE_CHANNEL_CORE,
  WORLD_PAGE_GUTTER,
  coreToStoredIndex,
  storedEdge,
} from "@/src/render/webgpu/world/pageGeometry";
import {
  createWorldPageKey,
  worldPageBounds,
  type WorldPageAddress,
} from "@/src/render/webgpu/world/pageKey";
import {
  decodeWorldPageFlowAccum,
  decodeWorldPageLakeDepth,
  decodeWorldPageShoreDistance,
  decodeWorldPageSoilDepth,
  encodeWorldPageFlowAccum,
  encodeWorldPageLakeDepth,
  encodeWorldPageShoreDistance,
  encodeWorldPageSoilDepth,
  type QuantizedHydrologyPage,
} from "@/src/render/webgpu/world/payload";

/** The epsilon in the canonical `ln((1 + A) / (tan(S) + epsilon))` TWI. */
export const TERRAIN_TWI_SLOPE_EPSILON = 1e-4;
/**
 * Stable mapping range used when TWI becomes a unit wetness classifier driver.
 *
 * W-9 (Phase 6 Gate W, register C-11 / RESOLUTION_PLAN A-3): re-windowed from
 * the original guess of [4, 18] against measured eroded page statistics
 * (`scripts/twi-stats.mts`, 24 L0 pages x 2 seeds, ~431k channel texels each):
 * the real distribution runs ~13.3 (p1) to ~29 (p99.9) with a median near 18,
 * so [4, 18] had an empty dry half (nothing below 13) and saturated ~half of
 * all land fully wet. [15, 24] puts ridges/upper slopes at 0, spreads
 * mid-slopes across the ramp, and reserves saturation for valley floors
 * (p95+ on both measured seeds). Eroded-only: the analytic classifier path
 * falls back to the moisture proxy before this window is consulted.
 */
export const TERRAIN_TWI_DRY = 15;
export const TERRAIN_TWI_WET = 24;

const MAX_LAKE_DEPTH_METERS = 65_535
  * TERRAIN_PAGE_HYDROLOGY_ENCODING.lakeDepthMetersPerUnit;
const MIN_SHORE_DISTANCE_METERS = -32_768
  * TERRAIN_PAGE_HYDROLOGY_ENCODING.shoreDistanceMetersPerUnit;
const MAX_SHORE_DISTANCE_METERS = 32_767
  * TERRAIN_PAGE_HYDROLOGY_ENCODING.shoreDistanceMetersPerUnit;

/**
 * Canonical topographic wetness index. `slopeRadians` is the terrain angle,
 * not `1 - normalY`; contributing area is the exported square-metre field.
 */
export function terrainTopographicWetnessIndex(
  flowAccumulationAreaM2: number,
  slopeRadians: number,
  epsilon = TERRAIN_TWI_SLOPE_EPSILON,
): number {
  if (!Number.isFinite(flowAccumulationAreaM2) || flowAccumulationAreaM2 < 0) {
    throw new RangeError("TWI flow accumulation must be finite and non-negative");
  }
  if (!Number.isFinite(slopeRadians) || slopeRadians < 0 || slopeRadians >= Math.PI * 0.5) {
    throw new RangeError("TWI slope must be a finite angle in [0, pi/2)");
  }
  if (!Number.isFinite(epsilon) || epsilon <= 0) {
    throw new RangeError("TWI epsilon must be finite and positive");
  }
  return Math.log((1 + flowAccumulationAreaM2) / (Math.tan(slopeRadians) + epsilon));
}

/** Smooth unit mapping kept separate so the physical TWI remains inspectable. */
export function terrainTopographicWetnessToUnit(twi: number): number {
  if (!Number.isFinite(twi)) throw new RangeError("TWI must be finite");
  const t = Math.max(0, Math.min(1, (twi - TERRAIN_TWI_DRY) / (TERRAIN_TWI_WET - TERRAIN_TWI_DRY)));
  return t * t * (3 - 2 * t);
}

/** Converts the classifier's `1 - normalY` slope convention to an angle. */
export function terrainSlopeAngleFromNormalizedSteepness(slope: number): number {
  if (!Number.isFinite(slope) || slope < 0 || slope >= 1) {
    throw new RangeError("Normalized terrain steepness must be finite and in [0, 1)");
  }
  const normalY = Math.max(1e-6, 1 - slope);
  return Math.atan(Math.sqrt(Math.max(0, 1 / (normalY * normalY) - 1)));
}

/**
 * Season- and tier-independent soil proxy. Valleys/depositional curvature,
 * real contributing area and gentle slopes retain the deepest soil.
 */
export function terrainSoilDepthMeters(
  slopeRadians: number,
  convergenceCurvature: number,
  topographicWetnessIndex: number,
): number {
  if (!Number.isFinite(slopeRadians) || slopeRadians < 0 || slopeRadians >= Math.PI * 0.5) {
    throw new RangeError("Soil slope must be a finite angle in [0, pi/2)");
  }
  if (!Number.isFinite(convergenceCurvature)) {
    throw new RangeError("Soil curvature must be finite");
  }
  const slopeRetention = Math.exp(-Math.tan(slopeRadians) / 0.35);
  const depositional = Math.max(0, Math.min(1, 0.5 - convergenceCurvature * 8));
  const wetness = terrainTopographicWetnessToUnit(topographicWetnessIndex);
  return Math.max(0, Math.min(
    TERRAIN_PAGE_HYDROLOGY_ENCODING.soilDepthMaxMeters,
    TERRAIN_PAGE_HYDROLOGY_ENCODING.soilDepthMaxMeters
      * slopeRetention
      * (0.4 + 0.6 * depositional)
      * (0.65 + 0.35 * wetness),
  ));
}

/**
 * `W-4` (Phase 6, Gate W, register C-4): how much of the post-erosion fine
 * band (`sampleTerrainFineBandRelief`) survives at a texel.
 *
 * This is the mask that REPLACES the uplift term's `localRock * lithology`
 * envelope. Its two inputs are the ones §12.1's landscape model names: soil
 * depth and convergence curvature, both read off the EVOLVED surface rather
 * than off the tectonic input, which is the whole substance of the move.
 * Structure shows through thin soil on a convex crest or a steep rock face,
 * and is buried under the deep soil of a convergent, wet, low-gradient hollow.
 *
 * SHARED ACCESSOR, DELIBERATELY. The mask lives here, beside
 * {@link terrainSoilDepthMeters}, because soil depth has exactly one
 * definition site and the band must not acquire a second one. What it does NOT
 * do is read the hydrology PRODUCT: the page's quantized `soilDepth` channel
 * is computed on the 4 m channel grid from the height the band has already
 * modified, so consuming it would be circular and half-resolution. The erosion
 * pass instead evaluates this function per HEIGHT texel (2 m at L0) from the
 * pre-band evolved surface — see `applyTerrainFineBandRelief`.
 *
 * Thresholds are measured, not guessed. Over the W-7 page spread, sampled at
 * height-texel resolution on the eroded surface (2026-08-30, ~17k samples):
 *
 *   regime   p5     p25    p50    p75    p95
 *   ridge    0.65   1.77   2.41   2.96   3.85   m of soil proxy
 *   slope    0.89   2.22   2.73   3.34   4.54
 *   valley   1.29   2.88   3.60   4.40   5.16
 *
 * [1.0, 4.0] m therefore spans the whole crest-to-floor range: steep rock and
 * the driest crest texels saturate at full survival, valley floors sit at or
 * past the deep end, and the mid-slopes land on the ramp. The resulting mean
 * survival is 0.28 overall — 0.33 on ridge pages, 0.29 on slope pages, 0.13 on
 * valley pages, which is the 2.5:1 crest-to-floor selectivity the mask exists
 * to produce.
 */
export const TERRAIN_FINE_BAND_SOIL_THIN_METERS = 1;
export const TERRAIN_FINE_BAND_SOIL_DEEP_METERS = 4;
/**
 * Curvature window, in 1/m, on the same `(centre - mean of four neighbours) /
 * spacing` convention {@link buildTerrainPageHydrology} uses: positive is a
 * crest, negative a convergent hollow. Read at the height texel's own arm.
 */
export const TERRAIN_FINE_BAND_CONCAVE_CURVATURE = -0.02;
export const TERRAIN_FINE_BAND_CONVEX_CURVATURE = 0.01;

export function terrainFineBandSurvival(
  soilDepthMeters: number,
  convergenceCurvature: number,
): number {
  if (!Number.isFinite(soilDepthMeters) || soilDepthMeters < 0) {
    throw new RangeError("Fine-band soil depth must be finite and non-negative");
  }
  if (!Number.isFinite(convergenceCurvature)) {
    throw new RangeError("Fine-band curvature must be finite");
  }
  const thinSoil = 1 - smoothstep(
    TERRAIN_FINE_BAND_SOIL_THIN_METERS,
    TERRAIN_FINE_BAND_SOIL_DEEP_METERS,
    soilDepthMeters,
  );
  const convex = smoothstep(
    TERRAIN_FINE_BAND_CONCAVE_CURVATURE,
    TERRAIN_FINE_BAND_CONVEX_CURVATURE,
    convergenceCurvature,
  );
  return thinSoil * convex;
}

export interface TerrainMacroLakeFieldLayout {
  readonly width: number;
  readonly height: number;
  readonly texelSizeMeters: number;
  /** World coordinate of sample (0, 0), not the outer grid edge. */
  readonly sampleOriginX: number;
  readonly sampleOriginZ: number;
}

export interface TerrainMacroLakeField {
  readonly layout: TerrainMacroLakeFieldLayout;
  readonly lakeMask: Uint8Array;
  /** Spill elevation at wet samples; zero at dry samples. */
  readonly surfaceElevationMeters: Float32Array;
}

export interface TerrainMacroLakeFieldBasin {
  readonly basinId: number;
  readonly outletIndex: number;
  readonly spillElevationMeters: number;
}

export interface TerrainMacroLakeFieldBuildInput {
  readonly layout: TerrainMacroLakeFieldLayout;
  readonly lakeMask: ArrayLike<number>;
  readonly basins: readonly TerrainMacroLakeFieldBasin[];
}

function requirePositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive integer`);
  }
  return value;
}

function validateLakeLayout(layout: TerrainMacroLakeFieldLayout): number {
  const width = requirePositiveInteger(layout.width, "Macro-lake width");
  const height = requirePositiveInteger(layout.height, "Macro-lake height");
  if (!Number.isFinite(layout.texelSizeMeters) || layout.texelSizeMeters <= 0) {
    throw new RangeError("Macro-lake texel size must be finite and positive");
  }
  if (!Number.isFinite(layout.sampleOriginX) || !Number.isFinite(layout.sampleOriginZ)) {
    throw new RangeError("Macro-lake sample origin must be finite");
  }
  return width * height;
}

const LAKE_NEIGHBOURS = Object.freeze([
  [-1, -1], [0, -1], [1, -1],
  [-1, 0],             [1, 0],
  [-1, 1],  [0, 1],   [1, 1],
] as const);

/**
 * Labels the macro's binary retained-lake mask from its canonical outlet
 * seeds. This recovers the per-basin spill association deliberately omitted
 * from the compact transferable mask without inventing lake levels per page.
 */
export function buildTerrainMacroLakeFieldFromGrid(
  input: TerrainMacroLakeFieldBuildInput,
): TerrainMacroLakeField {
  const count = validateLakeLayout(input.layout);
  if (input.lakeMask.length !== count) throw new RangeError("Macro-lake mask length mismatch");
  const mask = new Uint8Array(count);
  for (let index = 0; index < count; index += 1) {
    const value = input.lakeMask[index];
    if (value !== 0 && value !== 1) throw new RangeError(`Macro-lake mask[${index}] must be 0 or 1`);
    mask[index] = value;
  }
  const surface = new Float32Array(count);
  const assigned = new Uint8Array(count);
  const queue = new Int32Array(count);
  const basins = [...input.basins].sort((first, second) => first.basinId - second.basinId);
  for (const basin of basins) {
    if (!Number.isSafeInteger(basin.basinId) || basin.basinId < 0) {
      throw new RangeError("Macro-lake basin id must be a non-negative integer");
    }
    if (!Number.isSafeInteger(basin.outletIndex)
      || basin.outletIndex < 0
      || basin.outletIndex >= count
      || mask[basin.outletIndex] === 0) {
      throw new RangeError(`Macro-lake basin ${basin.basinId} has an invalid outlet`);
    }
    if (!Number.isFinite(basin.spillElevationMeters)) {
      throw new RangeError(`Macro-lake basin ${basin.basinId} spill must be finite`);
    }
    if (assigned[basin.outletIndex]) {
      throw new RangeError("Two macro-lake basin outlets belong to the same component");
    }
    let head = 0;
    let tail = 0;
    queue[tail] = basin.outletIndex;
    tail += 1;
    assigned[basin.outletIndex] = 1;
    while (head < tail) {
      const index = queue[head]!;
      head += 1;
      surface[index] = Math.fround(basin.spillElevationMeters);
      const x = index % input.layout.width;
      const z = Math.floor(index / input.layout.width);
      for (const [dx, dz] of LAKE_NEIGHBOURS) {
        const nx = x + dx;
        const nz = z + dz;
        if (nx < 0 || nz < 0 || nx >= input.layout.width || nz >= input.layout.height) continue;
        const neighbour = nz * input.layout.width + nx;
        if (!mask[neighbour] || assigned[neighbour]) continue;
        assigned[neighbour] = 1;
        queue[tail] = neighbour;
        tail += 1;
      }
    }
  }
  for (let index = 0; index < count; index += 1) {
    if (mask[index] && !assigned[index]) {
      throw new RangeError(`Macro-lake component containing sample ${index} has no basin outlet`);
    }
  }
  return Object.freeze({
    layout: Object.freeze({ ...input.layout }),
    lakeMask: mask,
    surfaceElevationMeters: surface,
  });
}

/** One-time canonical adapter; callers may reuse the result for every page. */
export function buildTerrainMacroLakeField(
  macro: Readonly<TerrainMacroEvolutionExport>,
): TerrainMacroLakeField {
  if (macro.contractVersion !== TERRAIN_EVOLUTION_CONTRACT_VERSION) {
    throw new RangeError("Macro evolution contract version mismatch");
  }
  if (macro.lakeMask.length !== EVOLUTION_DOMAIN_SAMPLE_COUNT) {
    throw new RangeError("Macro lake mask does not match the canonical 1024-square layout");
  }
  return buildTerrainMacroLakeFieldFromGrid({
    layout: {
      width: TERRAIN_EVOLUTION_MACRO_LAYOUT.texelsPerEdge,
      height: TERRAIN_EVOLUTION_MACRO_LAYOUT.texelsPerEdge,
      texelSizeMeters: EVOLUTION_TEXEL_METERS,
      sampleOriginX: TERRAIN_EVOLUTION_MACRO_LAYOUT.minWorldX + EVOLUTION_TEXEL_METERS * 0.5,
      sampleOriginZ: TERRAIN_EVOLUTION_MACRO_LAYOUT.minWorldZ + EVOLUTION_TEXEL_METERS * 0.5,
    },
    lakeMask: macro.lakeMask,
    basins: macro.lakes.map((lake) => ({
      basinId: lake.lakeId,
      outletIndex: lake.outletTexel.z * EVOLUTION_DOMAIN_TEXELS + lake.outletTexel.x,
      spillElevationMeters: lake.spillElevationMeters,
    })),
  });
}

export interface TerrainMacroLakeSample {
  readonly coverage: number;
  readonly surfaceElevationMeters: number;
}

/** Bilinear lake coverage with spill elevation normalized over wet contributors. */
export function sampleTerrainMacroLakeField(
  field: TerrainMacroLakeField,
  worldX: number,
  worldZ: number,
): TerrainMacroLakeSample {
  if (!Number.isFinite(worldX) || !Number.isFinite(worldZ)) {
    throw new RangeError("Macro-lake sample position must be finite");
  }
  const { layout } = field;
  const sampleAxis = (world: number, origin: number, edge: number): readonly [number, number, number] => {
    const coordinate = (world - origin) / layout.texelSizeMeters;
    const first = Math.max(0, Math.min(edge - 1, Math.floor(coordinate)));
    const second = Math.max(0, Math.min(edge - 1, first + 1));
    return [first, second, Math.max(0, Math.min(1, coordinate - first))];
  };
  const [x0, x1, tx] = sampleAxis(worldX, layout.sampleOriginX, layout.width);
  const [z0, z1, tz] = sampleAxis(worldZ, layout.sampleOriginZ, layout.height);
  let coverage = 0;
  let weightedSurface = 0;
  for (const [x, z, weight] of [
    [x0, z0, (1 - tx) * (1 - tz)],
    [x1, z0, tx * (1 - tz)],
    [x0, z1, (1 - tx) * tz],
    [x1, z1, tx * tz],
  ] as const) {
    const index = z * layout.width + x;
    const wetWeight = weight * field.lakeMask[index]!;
    coverage += wetWeight;
    weightedSurface += wetWeight * field.surfaceElevationMeters[index]!;
  }
  return Object.freeze({
    coverage,
    surfaceElevationMeters: coverage > 0 ? weightedSurface / coverage : 0,
  });
}

function squaredDistanceTransform1d(
  source: Float64Array,
  length: number,
  target: Float64Array,
  sites: Int32Array,
  boundaries: Float64Array,
): void {
  let top = -1;
  for (let coordinate = 0; coordinate < length; coordinate += 1) {
    if (!Number.isFinite(source[coordinate])) continue;
    if (top < 0) {
      top = 0;
      sites[0] = coordinate;
      boundaries[0] = Number.NEGATIVE_INFINITY;
      boundaries[1] = Number.POSITIVE_INFINITY;
      continue;
    }
    let intersection = 0;
    while (top >= 0) {
      const previous = sites[top]!;
      intersection = (
        source[coordinate]! + coordinate * coordinate
        - source[previous]! - previous * previous
      ) / (2 * (coordinate - previous));
      if (intersection > boundaries[top]!) break;
      top -= 1;
    }
    top += 1;
    sites[top] = coordinate;
    boundaries[top] = top === 0 ? Number.NEGATIVE_INFINITY : intersection;
    boundaries[top + 1] = Number.POSITIVE_INFINITY;
  }
  if (top < 0) {
    target.fill(Number.POSITIVE_INFINITY, 0, length);
    return;
  }
  let interval = 0;
  for (let coordinate = 0; coordinate < length; coordinate += 1) {
    while (interval < top && boundaries[interval + 1]! < coordinate) interval += 1;
    const site = sites[interval]!;
    const delta = coordinate - site;
    target[coordinate] = delta * delta + source[site]!;
  }
}

function squaredDistanceToMask(
  mask: ArrayLike<number>,
  width: number,
  height: number,
  targetValue: 0 | 1,
): Float64Array {
  const intermediate = new Float64Array(width * height);
  const output = new Float64Array(width * height);
  const longest = Math.max(width, height);
  const sourceLine = new Float64Array(longest);
  const targetLine = new Float64Array(longest);
  const sites = new Int32Array(longest);
  const boundaries = new Float64Array(longest + 1);
  for (let x = 0; x < width; x += 1) {
    for (let z = 0; z < height; z += 1) {
      sourceLine[z] = Number(mask[z * width + x] !== 0) === targetValue
        ? 0
        : Number.POSITIVE_INFINITY;
    }
    squaredDistanceTransform1d(sourceLine, height, targetLine, sites, boundaries);
    for (let z = 0; z < height; z += 1) intermediate[z * width + x] = targetLine[z]!;
  }
  for (let z = 0; z < height; z += 1) {
    for (let x = 0; x < width; x += 1) sourceLine[x] = intermediate[z * width + x]!;
    squaredDistanceTransform1d(sourceLine, width, targetLine, sites, boundaries);
    for (let x = 0; x < width; x += 1) output[z * width + x] = targetLine[x]!;
  }
  return output;
}

/**
 * Exact Euclidean centre-distance transform with the shoreline halfway
 * between opposite-class texel centres. Negative is retained water.
 */
export function terrainSignedShoreDistance(
  wetMask: ArrayLike<number>,
  width: number,
  height: number,
  texelSizeMeters: number,
): Float32Array {
  requirePositiveInteger(width, "Shore-distance width");
  requirePositiveInteger(height, "Shore-distance height");
  if (wetMask.length !== width * height) throw new RangeError("Shore-distance mask length mismatch");
  if (!Number.isFinite(texelSizeMeters) || texelSizeMeters <= 0) {
    throw new RangeError("Shore-distance texel size must be finite and positive");
  }
  const toWet = squaredDistanceToMask(wetMask, width, height, 1);
  const toDry = squaredDistanceToMask(wetMask, width, height, 0);
  const signed = new Float32Array(width * height);
  for (let index = 0; index < signed.length; index += 1) {
    const wet = wetMask[index] !== 0;
    const squared = wet ? toDry[index]! : toWet[index]!;
    if (!Number.isFinite(squared)) {
      signed[index] = wet ? MIN_SHORE_DISTANCE_METERS : MAX_SHORE_DISTANCE_METERS;
      continue;
    }
    const distance = Math.max(0.5, Math.sqrt(squared) - 0.5) * texelSizeMeters;
    signed[index] = Math.fround(wet
      ? Math.max(MIN_SHORE_DISTANCE_METERS, -distance)
      : Math.min(MAX_SHORE_DISTANCE_METERS, distance));
  }
  return signed;
}

export interface TerrainPageHydrologyUpload {
  /** IEEE-754 half bits containing log2(areaM2 + 1), for the R16F atlas. */
  readonly flowAccumR16Float: Uint16Array;
  /** IEEE-754 half bits containing metres, for the R16F atlas. */
  readonly lakeDepthR16Float: Uint16Array;
  readonly soilDepthR8Unorm: Uint8Array;
  readonly shoreDistanceR16Sint: Int16Array;
}

export interface TerrainPageHydrologyResult extends TerrainEvolutionPageExport {
  readonly address: WorldPageAddress;
  readonly coreSize: number;
  readonly gutter: number;
  readonly storedEdge: number;
  readonly texelSizeMeters: number;
  readonly upload: TerrainPageHydrologyUpload;
}

export interface TerrainPageHydrologyBuildInput {
  readonly address: WorldPageAddress;
  /** Converged fixed-DAG fields, before the scratch halo is discarded. */
  readonly erosion: TerrainErosionResult;
  /** Prepared once from the canonical macro export and reused across pages. */
  readonly macroLakes: TerrainMacroLakeField;
  /** Fixture seam; production is the canonical 128 core. */
  readonly channelCoreSize?: number;
  /** Fixture seam; production is the canonical four-texel gutter. */
  readonly gutter?: number;
}

function createQuantizedHydrology(count: number): QuantizedHydrologyPage {
  return {
    format: "r16uint-log-flow+r16uint-lake-depth+r8unorm-soil+r16sint-shore-v2",
    flowAccum: new Uint16Array(count),
    lakeDepth: new Uint16Array(count),
    soilDepth: new Uint8Array(count),
    shoreDistance: new Int16Array(count),
    ...TERRAIN_PAGE_HYDROLOGY_ENCODING,
  };
}

const FLOAT32_VIEW = new Float32Array(1);
const FLOAT32_BITS = new Uint32Array(FLOAT32_VIEW.buffer);

/** Deterministic non-negative float32 to IEEE-754 binary16 packing. */
export function terrainHydrologyFloat16Bits(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError("Hydrology R16F value must be finite and non-negative");
  }
  FLOAT32_VIEW[0] = value;
  const bits = FLOAT32_BITS[0]!;
  const exponent = ((bits >>> 23) & 0xff) - 127 + 15;
  const sign = (bits >>> 16) & 0x8000;
  if (exponent <= 0) return sign;
  if (exponent >= 31) return sign | 0x7c00;
  const mantissa = (bits & 0x7f_ffff) + 0x1000;
  if (mantissa >= 0x80_0000) {
    if (exponent + 1 >= 31) return sign | 0x7c00;
    return sign | ((exponent + 1) << 10);
  }
  return sign | (exponent << 10) | (mantissa >>> 13);
}

function validateErosionForHydrology(
  erosion: TerrainErosionResult,
  channelCoreSize: number,
  gutter: number,
): number {
  requirePositiveInteger(channelCoreSize, "Hydrology channel core");
  if (!Number.isSafeInteger(gutter) || gutter < 0) {
    throw new RangeError("Hydrology gutter must be a non-negative integer");
  }
  if (erosion.coreSize % channelCoreSize !== 0) {
    throw new RangeError("Erosion core must be an integer multiple of the hydrology core");
  }
  const scale = erosion.coreSize / channelCoreSize;
  const count = erosion.scratchEdge * erosion.scratchEdge;
  for (const [label, field] of [
    ["evolved height", erosion.evolvedHeight],
    ["flow accumulation", erosion.flowAccumulation],
  ] as const) {
    if (field.length !== count) throw new RangeError(`Erosion ${label} length mismatch`);
  }
  if (erosion.haloTexels < (gutter + 1) * scale) {
    throw new RangeError("Erosion halo is too small for hydrology gutter derivatives");
  }
  if (!Number.isFinite(erosion.texelSizeMeters) || erosion.texelSizeMeters <= 0) {
    throw new RangeError("Erosion texel size must be finite and positive");
  }
  return scale;
}

/**
 * Pure 136-square auxiliary-channel producer. It has no Babylon, quality-tier,
 * frame-clock, atlas, or residency dependency; those only consume `upload`.
 */
export function buildTerrainPageHydrology(
  input: TerrainPageHydrologyBuildInput,
): TerrainPageHydrologyResult {
  const channelCoreSize = input.channelCoreSize ?? WORLD_PAGE_CHANNEL_CORE;
  const gutter = input.gutter ?? WORLD_PAGE_GUTTER;
  const scale = validateErosionForHydrology(input.erosion, channelCoreSize, gutter);
  const outputEdge = storedEdge(channelCoreSize, gutter);
  const count = outputEdge * outputEdge;
  const channelTexelSize = input.erosion.texelSizeMeters * scale;
  const bounds = worldPageBounds(input.address, WORLD_PAGE_BASE_EXTENT_METERS);
  const quantized = createQuantizedHydrology(count);
  const flowUpload = new Uint16Array(count);
  const lakeUpload = new Uint16Array(count);
  const wetMask = new Uint8Array(count);
  const flowArea = new Float64Array(count);
  const lakeDepth = new Float64Array(count);
  const soilDepth = new Float64Array(count);

  const boxAverage = (field: ArrayLike<number>, row: number, column: number): number => {
    let total = 0;
    const startRow = input.erosion.haloTexels + row * scale;
    const startColumn = input.erosion.haloTexels + column * scale;
    for (let dz = 0; dz < scale; dz += 1) {
      for (let dx = 0; dx < scale; dx += 1) {
        total += field[(startRow + dz) * input.erosion.scratchEdge + startColumn + dx]!;
      }
    }
    return total / (scale * scale);
  };
  const heightAt = (row: number, column: number): number =>
    boxAverage(input.erosion.evolvedHeight, row, column);

  for (let row = -gutter; row < channelCoreSize + gutter; row += 1) {
    for (let column = -gutter; column < channelCoreSize + gutter; column += 1) {
      const index = coreToStoredIndex(row, column, channelCoreSize, gutter);
      const centreHeight = heightAt(row, column);
      const localFlowTexels = Math.max(0, boxAverage(input.erosion.flowAccumulation, row, column));
      flowArea[index] = Math.min(
        TERRAIN_FLOW_ACCUMULATION_MAX_AREA_M2,
        localFlowTexels * input.erosion.texelSizeMeters * input.erosion.texelSizeMeters,
      );
      const sampleOffset = (scale - 1) * 0.5 * input.erosion.texelSizeMeters;
      const worldX = bounds.minX + column * channelTexelSize + sampleOffset;
      const worldZ = bounds.minZ + row * channelTexelSize + sampleOffset;
      const macroLake = sampleTerrainMacroLakeField(input.macroLakes, worldX, worldZ);
      // The macro sampler clamps at its outer sample centres. Apply D2's
      // canonical rim blend before thresholding so a boundary lake cannot be
      // repeated indefinitely beyond the finite evolution domain.
      const lakeCoverage = macroLake.coverage * terrainEvolutionMacroBlend(worldX, worldZ);
      const depth = lakeCoverage >= 0.5
        ? Math.max(0, Math.min(MAX_LAKE_DEPTH_METERS, macroLake.surfaceElevationMeters - centreHeight))
        : 0;
      lakeDepth[index] = depth;
      wetMask[index] = depth > 0 ? 1 : 0;

      const west = heightAt(row, column - 1);
      const east = heightAt(row, column + 1);
      const north = heightAt(row - 1, column);
      const south = heightAt(row + 1, column);
      const gradientX = (east - west) / (2 * channelTexelSize);
      const gradientZ = (south - north) / (2 * channelTexelSize);
      const slopeRadians = Math.atan(Math.hypot(gradientX, gradientZ));
      // Positive is a crest, negative is a convergent/depositional hollow.
      const convergenceCurvature = (
        centreHeight - (west + east + north + south) * 0.25
      ) / channelTexelSize;
      const twi = terrainTopographicWetnessIndex(flowArea[index]!, slopeRadians);
      soilDepth[index] = terrainSoilDepthMeters(slopeRadians, convergenceCurvature, twi);
    }
  }

  const signedShore = terrainSignedShoreDistance(
    wetMask,
    outputEdge,
    outputEdge,
    channelTexelSize,
  );
  for (let index = 0; index < count; index += 1) {
    const area = flowArea[index]!;
    const depth = lakeDepth[index]!;
    quantized.flowAccum[index] = encodeWorldPageFlowAccum(quantized, area);
    quantized.lakeDepth[index] = encodeWorldPageLakeDepth(quantized, depth);
    quantized.soilDepth[index] = encodeWorldPageSoilDepth(quantized, soilDepth[index]!);
    quantized.shoreDistance[index] = encodeWorldPageShoreDistance(quantized, signedShore[index]!);
    flowUpload[index] = terrainHydrologyFloat16Bits(encodeTerrainFlowAccumulationLog2(area));
    lakeUpload[index] = terrainHydrologyFloat16Bits(depth);
  }
  const frozenHydrology = Object.freeze(quantized);
  return Object.freeze({
    pageKey: createWorldPageKey(input.address),
    address: input.address,
    hydrology: frozenHydrology,
    coreSize: channelCoreSize,
    gutter,
    storedEdge: outputEdge,
    texelSizeMeters: channelTexelSize,
    upload: Object.freeze({
      flowAccumR16Float: flowUpload,
      lakeDepthR16Float: lakeUpload,
      soilDepthR8Unorm: frozenHydrology.soilDepth,
      shoreDistanceR16Sint: frozenHydrology.shoreDistance,
    }),
  });
}

export function terrainPageHydrologyTransferables(
  page: TerrainPageHydrologyResult,
): ArrayBuffer[] {
  const arrays: readonly ArrayBufferView[] = [
    page.hydrology.flowAccum,
    page.hydrology.lakeDepth,
    page.hydrology.soilDepth,
    page.hydrology.shoreDistance,
    page.upload.flowAccumR16Float,
    page.upload.lakeDepthR16Float,
  ];
  const buffers = new Set<ArrayBuffer>();
  for (const array of arrays) {
    if (array.buffer instanceof ArrayBuffer && array.buffer.byteLength > 0) buffers.add(array.buffer);
  }
  return [...buffers];
}

export type TerrainPageHydrologyChildren = readonly [
  QuantizedHydrologyPage,
  QuantizedHydrologyPage,
  QuantizedHydrologyPage,
  QuantizedHydrologyPage,
];

export interface TerrainHydrologyCoreAggregation {
  readonly coreSize: number;
  /** Core only. Parent gutters require neighbouring child quartets. */
  readonly hydrology: QuantizedHydrologyPage;
}

/**
 * Canonical cross-level reducer. Child order matches `childWorldPageAddresses`:
 * minX/minZ, maxX/minZ, minX/maxZ, maxX/maxZ. Physical values are averaged
 * before re-quantization; logarithmic flow samples are never averaged directly.
 */
export function aggregateTerrainPageHydrologyChildren(
  children: TerrainPageHydrologyChildren,
  coreSize = WORLD_PAGE_CHANNEL_CORE,
  gutter = WORLD_PAGE_GUTTER,
): TerrainHydrologyCoreAggregation {
  requirePositiveInteger(coreSize, "Hydrology aggregation core");
  if (!Number.isSafeInteger(gutter) || gutter < 0) {
    throw new RangeError("Hydrology aggregation gutter must be non-negative");
  }
  const childEdge = storedEdge(coreSize, gutter);
  for (const child of children) {
    const count = childEdge * childEdge;
    if (
      child.flowAccum.length !== count
      || child.lakeDepth.length !== count
      || child.soilDepth.length !== count
      || child.shoreDistance.length !== count
    ) {
      throw new RangeError("Hydrology child dimensions do not match the declared core/gutter");
    }
  }
  const parent = createQuantizedHydrology(coreSize * coreSize);
  for (let row = 0; row < coreSize; row += 1) {
    for (let column = 0; column < coreSize; column += 1) {
      let area = 0;
      let lake = 0;
      let soil = 0;
      let shore = 0;
      for (let dz = 0; dz < 2; dz += 1) {
        for (let dx = 0; dx < 2; dx += 1) {
          const fineRow = row * 2 + dz;
          const fineColumn = column * 2 + dx;
          const childZ = fineRow >= coreSize ? 1 : 0;
          const childX = fineColumn >= coreSize ? 1 : 0;
          const child = children[childZ * 2 + childX]!;
          const localRow = fineRow % coreSize;
          const localColumn = fineColumn % coreSize;
          const childIndex = coreToStoredIndex(localRow, localColumn, coreSize, gutter);
          area += decodeWorldPageFlowAccum(child, child.flowAccum[childIndex]!);
          lake += decodeWorldPageLakeDepth(child, child.lakeDepth[childIndex]!);
          soil += decodeWorldPageSoilDepth(child, child.soilDepth[childIndex]!);
          shore += decodeWorldPageShoreDistance(child, child.shoreDistance[childIndex]!);
        }
      }
      const parentIndex = row * coreSize + column;
      parent.flowAccum[parentIndex] = encodeWorldPageFlowAccum(parent, area * 0.25);
      parent.lakeDepth[parentIndex] = encodeWorldPageLakeDepth(parent, lake * 0.25);
      parent.soilDepth[parentIndex] = encodeWorldPageSoilDepth(parent, soil * 0.25);
      parent.shoreDistance[parentIndex] = encodeWorldPageShoreDistance(parent, shore * 0.25);
    }
  }
  return Object.freeze({ coreSize, hydrology: Object.freeze(parent) });
}
