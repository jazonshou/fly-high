import { StorageBuffer } from "@babylonjs/core/Buffers/storageBuffer";
import type { ComputeShader } from "@babylonjs/core/Compute/computeShader";
import type { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import {
  registerGpuBufferBytes,
  releaseGpuBufferBytes,
} from "@/src/render/webgpu/core/GpuBufferInventory";
import { CLIMATE_PROVINCE } from "@/src/world/climateProvince";
import { DUNE_PROFILE_CONSTANTS, DUNES } from "@/src/world/dunes";
import { FRACTURE_EXPOSURE_MEAN, FRACTURE_RAVINE_MEAN } from "@/src/world/geology";
import {
  LOCAL_RIDGES_KNOLL_MEAN,
  RIDGES_INVERSE_POW_31_MEAN,
  RIDGES_POW_212_MEAN,
} from "@/src/world/terrain";
import { terrainKernelLatticeBase } from "./TerrainKernel";
import { VOLCANIC_OVERLAY_WGSL, emptyVolcanicSiteIndex } from "./VolcanicOverlayKernel";

/**
 * The WGSL landform stage — Class K, the transliteration of
 * `src/world/landforms.ts` and the stages it runs (`dunes.ts`).
 *
 * The CPU runs landforms AFTER the natural kernel and before the airport
 * earthworks (natural -> dunes -> volcanic overlay -> earthworks), reading
 * the kernel's intermediates off the call that produced the natural height.
 * The GPU does the same: `terrainNaturalHeight` records the same intermediates
 * into the private `kNatural`, and `terrainLandforms(localX, localZ, natural)`
 * reads them, so no stage evaluates the kernel twice. Every rule at the top
 * of `TerrainKernel.ts` applies here unchanged: split-origin addressing (the
 * dune phases ride the page uniform's landform rows, reduced in f64), the
 * hand-written `kSmoothstep`/`kLerp`, injected constants, and band-limit
 * weights as page constants.
 *
 * WHY A SEPARATE INCLUDE. Every terrain compute consumer composes
 * `TERRAIN_KERNEL_WGSL`, and the landform stage needs a binding of its own
 * (`terrainLandformData`, which the volcanic overlay fills). Kept out of the
 * kernel, only the consumers that draw landforms (page generation, the
 * height pyramid, the bathymetry bake) and the splat bake (which will read
 * sand cover) have to bind it; the shelved eroded path, the uplift kernel and
 * every parity harness keep the kernel exactly as it was.
 *
 * CONTAINMENT, the CPU's rule. `terrainLandforms` returns `natural` itself,
 * never `natural + 0.0`, on a page built without a landform input (gain 0),
 * inside the landform core, and wherever no stage's weight is positive.
 *
 * Requires, before it: `terrainKernelPageBindingWgsl(...)`,
 * `terrainLandformDataBindingWgsl(...)` and `TERRAIN_KERNEL_WGSL`.
 */

/**
 * Every figure the dune stage reads, imported rather than retyped and emitted
 * as `KL_<NAME>` constants: DUNES' own, the profile constants dunes.ts derives
 * from them (in f64, then rounded once to f32 here), and the kernel's measured
 * expectations the relief is measured from (the same imports dunes.ts makes).
 * A wrong digit in an expectation moves a sand sea's floor by metres on a
 * band-limited page and passes every parity probe at width 0.
 */
export const TERRAIN_LANDFORM_CONSTANTS = Object.freeze({
  LOCAL_RIDGES_KNOLL_MEAN,
  FRACTURE_EXPOSURE_MEAN,
  FRACTURE_RAVINE_MEAN,
  RIDGES_POW_212_MEAN,
  RIDGES_INVERSE_POW_31_MEAN,
  ARID_DRYNESS_LOW: DUNES.aridDrynessLow,
  ARID_DRYNESS_HIGH: DUNES.aridDrynessHigh,
  ERG_PATCH_LOW: DUNES.ergPatch.low,
  ERG_PATCH_HIGH: DUNES.ergPatch.high,
  LOW_GROUND_RISE_LOW: DUNES.lowGroundRiseLowMeters,
  LOW_GROUND_RISE_HIGH: DUNES.lowGroundRiseHighMeters,
  LOW_GROUND_FALL_LOW: DUNES.lowGroundFallLowMeters,
  LOW_GROUND_FALL_HIGH: DUNES.lowGroundFallHighMeters,
  HILL_LOW: DUNES.hillLow,
  HILL_HIGH: DUNES.hillHigh,
  RELIEF_DAMPING: DUNES.reliefDamping,
  ROLLING_DAMPING: DUNES.rollingDamping,
  SPACING: DUNES.spacingMeters,
  CREST_HEIGHT_MAX: DUNES.crestHeightMaxMeters,
  CREST_HEIGHT_MIN: DUNES.crestHeightMinMeters,
  BRINK_ROUNDING: DUNES.brinkRoundingMeters,
  MEANDER_AMPLITUDE: DUNES.meander.amplitudePeriods,
  MEANDER_FINE_AMPLITUDE: DUNES.meanderFine.amplitudePeriods,
  SCALLOP_WIDTH: DUNES.scallopWidthMeters,
  SCALLOP_AMPLITUDE: DUNES.scallopAmplitudePeriods,
  SCALLOP_STAGGER: DUNES.scallopStagger,
  SCALLOP_JITTER: DUNES.scallopJitter,
  CREST_THRESHOLD_FULL: DUNES.crestThresholdFull,
  CREST_THRESHOLD_THIN: DUNES.crestThresholdThin,
  CREST_HALF_WIDTH: DUNES.crestHalfWidth,
  HORN_SHIFT: DUNES.hornShift,
  SAND_COVER_LOW: DUNES.sandCoverLowMeters,
  SAND_COVER_HIGH: DUNES.sandCoverHighMeters,
  SAND_SHEET_LOW: DUNES.sandSheetLow,
  SAND_SHEET_HIGH: DUNES.sandSheetHigh,
  STOSS_TAN: DUNE_PROFILE_CONSTANTS.stossTan,
  SLIP_TAN: DUNE_PROFILE_CONSTANTS.slipTan,
  CREST_HEIGHT_LIMIT: DUNE_PROFILE_CONSTANTS.crestHeightLimitMeters,
  STOSS_SHAPE_INTEGRAL: DUNE_PROFILE_CONSTANTS.stossShapeIntegral,
});

/** A float literal WGSL accepts and a test can find verbatim. */
function wgslFloat(value: number): string {
  return Number.isInteger(value) ? `${value}.0` : String(value);
}

function landformConstantsWgsl(): string {
  return Object.entries(TERRAIN_LANDFORM_CONSTANTS)
    .map(([name, value]) => `const KL_${name}: f32 = ${wgslFloat(value)};`)
    .join("\n");
}

/**
 * Bytes of the placeholder `terrainLandformData` buffer: the EMPTY volcanic
 * site index (`emptyVolcanicSiteIndex`), which lists no bins and has no
 * volcanism, so the overlay returns its height and `terrainVolcanicActivity`
 * is exactly 0.0. A consumer binds one until it is handed a live
 * `TerrainLandformDataSource`. Size and register it from this name, never a
 * literal.
 */
export const TERRAIN_LANDFORM_DATA_PLACEHOLDER_BYTES = emptyVolcanicSiteIndex().data.byteLength;

/**
 * The landform data binding a consumer prepends: the volcanic site index
 * (`VolcanicOverlayKernel.ts` owns its layout and builder).
 */
export function terrainLandformDataBindingWgsl(group: number, binding: number): string {
  return /* wgsl */ `
@group(${group}) @binding(${binding}) var<storage, read> terrainLandformData: array<vec4f>;
`;
}

/**
 * The placeholder buffer, holding the empty site index. It registers
 * `TERRAIN_LANDFORM_DATA_PLACEHOLDER_BYTES` with the GPU buffer inventory
 * (Gate 0-c) as it allocates, so no consumer can forget to; whoever disposes
 * it releases the same constant. Prefer `createTerrainLandformPlaceholderSource`,
 * whose `dispose` does both.
 */
export function createTerrainLandformPlaceholderBuffer(engine: WebGPUEngine): StorageBuffer {
  const buffer = new StorageBuffer(engine, TERRAIN_LANDFORM_DATA_PLACEHOLDER_BYTES);
  registerGpuBufferBytes(TERRAIN_LANDFORM_DATA_PLACEHOLDER_BYTES);
  // Zeros would read as a bin grid of no size at a corner of 0: the empty
  // index's header says outright that nothing is listed and nothing is active.
  buffer.update(emptyVolcanicSiteIndex().data);
  return buffer;
}

/**
 * What a consumer binds as `terrainLandformData`: the volcanic overlay's site
 * index (`VolcanicSiteIndexStream`, which rebuilds as the camera moves), or
 * the placeholder (the empty index).
 *
 * `bufferVersion` changes whenever `buffer` is replaced, so a consumer
 * re-binds by comparing a number before each dispatch instead of being told.
 * `covers` says whether the index holds every site that can reach a world
 * rectangle; a consumer that bakes a page with known bounds defers it while
 * this is false, so the page is baked once, with its volcanoes, rather than
 * first without them.
 */
export interface TerrainLandformDataSource {
  readonly buffer: StorageBuffer;
  readonly bufferVersion: number;
  covers(minX: number, minZ: number, maxX: number, maxZ: number): boolean;
}

/** The placeholder as a source, which owns its buffer and its inventory bytes. */
export interface TerrainLandformPlaceholderSource extends TerrainLandformDataSource {
  /** Dispose the buffer and release its registered bytes. Idempotent. */
  dispose(): void;
}

/** The placeholder as a source: version 0, covering everything. */
export function createTerrainLandformPlaceholderSource(
  engine: WebGPUEngine,
): TerrainLandformPlaceholderSource {
  const buffer = createTerrainLandformPlaceholderBuffer(engine);
  let disposed = false;
  return {
    buffer,
    bufferVersion: 0,
    covers: () => true,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      buffer.dispose();
      releaseGpuBufferBytes(TERRAIN_LANDFORM_DATA_PLACEHOLDER_BYTES);
    },
  };
}

/**
 * One consumer's `terrainLandformData` binding: the source it was given, or a
 * placeholder it creates and owns, bound to its one pipeline and re-bound only
 * when the buffer or its version changes.
 *
 * WHY ONE HELPER. Four consumers bind this (page generation, the height
 * pyramid, the bathymetry bake and the splat bake), and each needs the same
 * three things: a lazily created placeholder (its constructor runs before the
 * engine is known to be WebGPU, and in Node tests with no engine at all),
 * disposed with the consumer (the placeholder source accounts for its own
 * bytes; a supplied source stays its owner's), and a re-bind that allocates
 * nothing per frame. Swapping the source never recreates the pipeline.
 */
export class TerrainLandformDataBinding {
  private placeholder: TerrainLandformPlaceholderSource | null = null;
  private boundShader: ComputeShader | null = null;
  private boundBuffer: StorageBuffer | null = null;
  private boundVersion = -1;

  constructor(private source: TerrainLandformDataSource | null = null) {}

  /** Replace the source (null returns to the placeholder); the next bind re-binds. */
  setSource(source: TerrainLandformDataSource | null): void {
    this.source = source;
  }

  /** False while this binds its own placeholder, which covers everything. */
  get hasSource(): boolean {
    return this.source !== null;
  }

  /** Whether the current source covers a world rectangle (the placeholder always does). */
  covers(minX: number, minZ: number, maxX: number, maxZ: number): boolean {
    return this.source ? this.source.covers(minX, minZ, maxX, maxZ) : true;
  }

  /** Bind the current source's buffer to shader, if it is not already bound. Before every dispatch. */
  bind(engine: WebGPUEngine, shader: ComputeShader): void {
    const source = this.source ?? this.ownedPlaceholder(engine);
    if (
      shader === this.boundShader
      && source.buffer === this.boundBuffer
      && source.bufferVersion === this.boundVersion
    ) return;
    shader.setStorageBuffer("terrainLandformData", source.buffer);
    this.boundShader = shader;
    this.boundBuffer = source.buffer;
    this.boundVersion = source.bufferVersion;
  }

  /** Dispose the placeholder this binding created; a supplied source is its owner's. */
  dispose(): void {
    this.placeholder?.dispose();
    this.placeholder = null;
    this.boundShader = null;
    this.boundBuffer = null;
    this.boundVersion = -1;
  }

  private ownedPlaceholder(engine: WebGPUEngine): TerrainLandformDataSource {
    this.placeholder ??= createTerrainLandformPlaceholderSource(engine);
    return this.placeholder;
  }
}

export const TERRAIN_LANDFORM_WGSL = /* wgsl */ `
// ---------------------------------------------------------------------------
// Landforms — TRANSLITERATION of src/world/{landforms,dunes}.ts. Generated by
// src/render/webgpu/terrain/TerrainLandformKernel.ts.
//
// Requires, before it: terrainKernelPageBindingWgsl(...),
// terrainLandformDataBindingWgsl(...) and TERRAIN_KERNEL_WGSL.
// ---------------------------------------------------------------------------

// ===== VOLCANIC HOOKS — the volcanic include (VolcanicOverlayKernel.ts) =====
${VOLCANIC_OVERLAY_WGSL}

/**
 * volcanicActivity (volcanism.ts) at a point LOCAL to the bound page, in
 * [0, 1]. Sand seas are multiplied by (1.0 - activity), so the two
 * landforms never stack. Exactly 0.0 inside a natural world's core, in a
 * world without volcanism, and on the placeholder (the empty index). It
 * reads terrainLandformData's header, so the binding stays reachable even
 * where no site is listed (Tint prunes a binding no live code reads).
 */
fn terrainVolcanicActivity(localX: f32, localZ: f32) -> f32 {
  return terrainVolcanicActivitySplit(terrainKernelPages[kPageIndex].landformBase, vec2f(localX, localZ));
}

// --- the dune stage: dunes.ts, line for line -------------------------------

${landformConstantsWgsl()}

/** stossShape: g(u) = u^2 (2 - u). */
fn terrainDuneStossShape(u: f32) -> f32 {
  return u * u * (2.0 - u);
}

/** smoothMin: the polynomial smooth minimum. */
fn terrainDuneSmoothMin(a: f32, b: f32, k: f32) -> f32 {
  let h = max(k - abs(a - b), 0.0) / k;
  return min(a, b) - h * h * k * 0.25;
}

/** duneProfileMeters: exactly 0 on the interdune floor and at both period ends. */
fn terrainDuneProfile(metersIntoPeriod: f32, crestHeight: f32) -> f32 {
  if (crestHeight <= 0.0) { return 0.0; }
  let slipLength = crestHeight / KL_SLIP_TAN;
  let stossLength = crestHeight / KL_STOSS_TAN;
  let crestAt = KL_SPACING - slipLength;
  let toeAt = crestAt - stossLength;
  if (metersIntoPeriod <= toeAt) { return 0.0; }
  // The stoss continues past the brink at its brink slope; the slipface line
  // continues back up past it; their smooth minimum rounds the brink.
  var stoss: f32;
  if (metersIntoPeriod <= crestAt) {
    stoss = crestHeight * terrainDuneStossShape((metersIntoPeriod - toeAt) / stossLength);
  } else {
    stoss = crestHeight + (metersIntoPeriod - crestAt) * KL_STOSS_TAN;
  }
  let slip = crestHeight - (metersIntoPeriod - crestAt) * KL_SLIP_TAN;
  return max(0.0, terrainDuneSmoothMin(stoss, slip, KL_BRINK_ROUNDING));
}

/** duneProfileMeanMeters: the profile's analytic mean over one period. */
fn terrainDuneProfileMean(crestHeight: f32) -> f32 {
  if (crestHeight <= 0.0) { return 0.0; }
  let k = KL_BRINK_ROUNDING;
  let area = crestHeight * (crestHeight / KL_STOSS_TAN) * KL_STOSS_SHAPE_INTEGRAL
    + crestHeight * (crestHeight / KL_SLIP_TAN) * 0.5
    - (k * k) / (6.0 * (KL_STOSS_TAN + KL_SLIP_TAN));
  return max(0.0, area) / KL_SPACING;
}

/** duneScallop: 0 at a crescent's middle, 1 at its joints. */
fn terrainDuneScallop(across: f32) -> f32 {
  let offset = 2.0 * (across - floor(across)) - 1.0;
  return offset * offset;
}

/**
 * duneRelief: (short, broad), each term measured from the kernel's own
 * expectation, read off the kNatural intermediates of the LAST
 * terrainNaturalHeight call. The land <= 0.0001 early-out is geology.ts' rule
 * 6 cliff, ported verbatim for the same reason.
 */
fn terrainDuneRelief() -> vec2f {
  let land = kNatural.land;
  let foothill = kNatural.foothillRegion;
  let mountain = kNatural.mountainRegion;
  let knollMean = land * (0.34 + foothill * 0.66) * KL_LOCAL_RIDGES_KNOLL_MEAN
    * (72.0 + foothill * 115.0);
  var geologyMean = 0.0;
  if (land > 0.0001) {
    geologyMean = land * (foothill * 0.52 + mountain * 0.78) * KL_FRACTURE_EXPOSURE_MEAN
        * (17.0 + mountain * 66.0)
      - land * (foothill * 0.32 + mountain * 0.7) * KL_FRACTURE_RAVINE_MEAN
        * (9.0 + mountain * 48.0);
  }
  let foothillMean = land * foothill * KL_RIDGES_POW_212_MEAN * 285.0;
  let valleyMean = land * foothill * KL_RIDGES_INVERSE_POW_31_MEAN * (55.0 + mountain * 105.0);
  let shortRelief = kNatural.fine * (5.0 + land * 12.0)
    + (kNatural.rockyKnolls - knollMean)
    + (kNatural.geologicalRelief - geologyMean);
  let broadRelief = kNatural.rolling * kNatural.hillStrength
    + (kNatural.foothillHeight - foothillMean)
    - (kNatural.valleyCarve - valleyMean);
  return vec2f(shortRelief, broadRelief);
}

/**
 * duneClimateFactors' arid factor: the arid province, a smoothstep over
 * unmaskedProvinceDryness (the dryness half of the unmasked province). Reads
 * two lattices and never the natural kernel.
 */
fn terrainDuneAridFactor(localX: f32, localZ: f32) -> f32 {
  let dryness = kProvinceDrynessStaircase(
    kFbm(${terrainKernelLatticeBase("provinceDryness")}u, ${CLIMATE_PROVINCE.dryness.octaves}u, localX, localZ));
  return kSmoothstep(KL_ARID_DRYNESS_LOW, KL_ARID_DRYNESS_HIGH, dryness);
}

/** ergPatchFactor: which arid ground is a sand sea. Never reads the natural kernel. */
fn terrainDunePatchFactor(localX: f32, localZ: f32) -> f32 {
  return kSmoothstep(
    KL_ERG_PATCH_LOW,
    KL_ERG_PATCH_HIGH,
    kFbm(${terrainKernelLatticeBase("duneErgPatch")}u, ${DUNES.ergPatch.octaves}u, localX, localZ),
  );
}

/**
 * duneErgWeight: the cheap factors the kernel already computed first, then
 * the province's dryness and the erg patch, returning 0 wherever a factor is
 * already 0 (on a real GPU that skips the lattices; SwiftShader runs both
 * sides of a branch, so there it saves nothing and costs nothing). A world
 * that forces dunes (landform.w) drops the province and patch factors.
 */
fn terrainDuneErgWeight(localX: f32, localZ: f32, coreMask: f32, relief: vec2f) -> f32 {
  let baseHeight = kNatural.shippedHeight - relief.x - relief.y;
  let lowGround = kSmoothstep(KL_LOW_GROUND_RISE_LOW, KL_LOW_GROUND_RISE_HIGH, baseHeight)
    * (1.0 - kSmoothstep(KL_LOW_GROUND_FALL_LOW, KL_LOW_GROUND_FALL_HIGH, baseHeight));
  let flatGround = 1.0 - kSmoothstep(KL_HILL_LOW, KL_HILL_HIGH, kNatural.foothillRegion);
  var weight = coreMask * lowGround * flatGround;
  if (weight <= 0.0) { return 0.0; }
  if (terrainKernelPages[kPageIndex].landform.w <= 0.0) {
    weight = weight * terrainDuneAridFactor(localX, localZ);
    if (weight <= 0.0) { return 0.0; }
    weight = weight * terrainDunePatchFactor(localX, localZ);
    if (weight <= 0.0) { return 0.0; }
  }
  return weight * (1.0 - terrainVolcanicActivity(localX, localZ));
}

/**
 * sampleDuneField's dune height for erg weight erg. The phases are the
 * page's (landformWind.zw, reduced in f64 at the page origin) plus the local
 * warped offset's own (rule 1), so the f32 phase stays a few periods at most
 * across a page instead of thousands.
 */
fn terrainDuneField(localX: f32, localZ: f32, erg: f32) -> f32 {
  let supply = erg;
  let crestNoise = kFilteredNoise(${terrainKernelLatticeBase("duneCrest")}u, localX, localZ);
  let threshold = KL_CREST_THRESHOLD_THIN
    + (KL_CREST_THRESHOLD_FULL - KL_CREST_THRESHOLD_THIN) * supply;
  let crest = kSmoothstep(
    threshold - KL_CREST_HALF_WIDTH,
    threshold + KL_CREST_HALF_WIDTH,
    crestNoise * 0.5 + 0.5,
  );
  let crestHeight = min(
    KL_CREST_HEIGHT_LIMIT,
    crest * (KL_CREST_HEIGHT_MIN + (KL_CREST_HEIGHT_MAX - KL_CREST_HEIGHT_MIN) * supply)
      * (0.8 + 0.2 * crestNoise),
  );
  let meanderNoise = kFilteredNoise(${terrainKernelLatticeBase("duneMeander")}u, localX, localZ);
  let meanderFineNoise =
    kFilteredNoise(${terrainKernelLatticeBase("duneMeanderFine")}u, localX, localZ);
  let wind = terrainKernelPages[kPageIndex].landformWind;
  // duneWindPhase and duneAcrossPhase of the LOCAL warped offset.
  let windLocal = (kNatural.warpedX * wind.x + kNatural.warpedZ * wind.y) / KL_SPACING;
  let acrossLocal = (kNatural.warpedX * wind.y - kNatural.warpedZ * wind.x) / KL_SCALLOP_WIDTH;
  let windPhase = wind.z + windLocal;
  // The page's across phase already carries the origin's stagger.
  let across = wind.w + acrossLocal + windLocal * KL_SCALLOP_STAGGER
    + meanderNoise * KL_SCALLOP_JITTER;
  let phase = windPhase
    + meanderNoise * KL_MEANDER_AMPLITUDE
    + meanderFineNoise * KL_MEANDER_FINE_AMPLITUDE
    - KL_SCALLOP_AMPLITUDE * (0.65 + 0.35 * crestNoise) * terrainDuneScallop(across)
    - KL_HORN_SHIFT * (1.0 - crest);
  let metersIntoPeriod = (phase - floor(phase)) * KL_SPACING;
  let mean = terrainDuneProfileMean(crestHeight);
  // octaveBandWeight(spacing, filterWidth): a page constant (rule 4).
  let kept = terrainKernelPages[kPageIndex].landformRadii.z;
  var profile = terrainDuneProfile(metersIntoPeriod, crestHeight);
  if (kept < 1.0) {
    profile = mean + (profile - mean) * kept;
  }
  return erg * profile;
}

/** duneFloorFlattening: mean-free, because the relief is. */
fn terrainDuneFloorFlattening(erg: f32, relief: vec2f) -> f32 {
  return -erg * (KL_RELIEF_DAMPING * relief.x + KL_ROLLING_DAMPING * relief.y);
}

/** sampleDuneField's sandCover: a dune body, or the sand sheet of a deep erg. */
fn terrainDuneSandCover(erg: f32, duneHeight: f32) -> f32 {
  return max(
    kSmoothstep(KL_SAND_COVER_LOW, KL_SAND_COVER_HIGH, duneHeight),
    kSmoothstep(KL_SAND_SHEET_LOW, KL_SAND_SHEET_HIGH, erg),
  );
}

/**
 * What the dune stage knows at a point: the erg weight, the dune height
 * (sampleDuneField's ergWeight and duneHeight) and the relief the floor
 * flattening reads. erg is 0, and the dune field unread, outside a sand sea.
 * The ONE evaluation the height stage and the sand cover share.
 */
struct TerrainDuneSample {
  erg: f32,
  duneHeight: f32,
  relief: vec2f,
};

fn terrainDuneSample(localX: f32, localZ: f32, coreMask: f32) -> TerrainDuneSample {
  let relief = terrainDuneRelief();
  let erg = terrainDuneErgWeight(localX, localZ, coreMask, relief);
  if (erg <= 0.0) { return TerrainDuneSample(0.0, 0.0, relief); }
  return TerrainDuneSample(erg, terrainDuneField(localX, localZ, erg), relief);
}

/**
 * applyDuneStage: height itself (the same number, not + 0.0) wherever the
 * erg weight is 0; inside a sand sea the flattened floor plus the dune field.
 */
fn terrainDuneStage(localX: f32, localZ: f32, height: f32, coreMask: f32) -> f32 {
  let dune = terrainDuneSample(localX, localZ, coreMask);
  if (dune.erg <= 0.0) { return height; }
  return height + terrainDuneFloorFlattening(dune.erg, dune.relief) + dune.duneHeight;
}

/**
 * landformCoreMask at a point local to the bound page: 0 inside the core,
 * exactly. The page origin's offset from the core's centre was subtracted in
 * f64, so only a local-sized vector reaches this length(). Callers check the
 * page's gain first.
 */
fn terrainLandformCoreMask(localX: f32, localZ: f32) -> f32 {
  let radii = terrainKernelPages[kPageIndex].landformRadii;
  return kSmoothstep(
    radii.x,
    radii.y,
    length(terrainKernelPages[kPageIndex].landform.xy + vec2f(localX, localZ)),
  );
}

/**
 * Whether a sand sea is possible here at all, WITHOUT the natural kernel:
 * false for a page without a landform input (gain 0) and inside the core,
 * true in a world that forces dunes, otherwise both of duneClimateFactors'
 * factors (the arid province, then the erg patch) positive. The GPU twin of
 * sampleErgFarWeight's early outs: a ground bake gates on it and skips the
 * kernel wherever it is false, which outside the core is most of the world.
 * terrainLandformSandCover is (0, 0) wherever it is false.
 */
fn terrainLandformClimateGate(localX: f32, localZ: f32) -> bool {
  let landform = terrainKernelPages[kPageIndex].landform;
  if (landform.z <= 0.0) { return false; }
  if (terrainLandformCoreMask(localX, localZ) <= 0.0) { return false; }
  if (landform.w > 0.0) { return true; }
  if (terrainDuneAridFactor(localX, localZ) <= 0.0) { return false; }
  return terrainDunePatchFactor(localX, localZ) > 0.0;
}

/**
 * sampleLandformCover's (ergWeight, sandCover) at a point LOCAL to the bound
 * page, for readers that classify the ground rather than draw it. natural is
 * the height the LAST terrainNaturalHeight call returned for this same point:
 * the stage reads that call's kNatural, as terrainLandforms does, and never
 * evaluates the kernel itself. (0, 0) wherever terrainLandforms leaves the
 * natural height untouched by the dunes: gain 0, inside the core, outside a
 * sand sea.
 */
fn terrainLandformSandCover(localX: f32, localZ: f32, natural: f32) -> vec2f {
  if (terrainKernelPages[kPageIndex].landform.z <= 0.0) { return vec2f(0.0, 0.0); }
  let coreMask = terrainLandformCoreMask(localX, localZ);
  if (coreMask <= 0.0) { return vec2f(0.0, 0.0); }
  let dune = terrainDuneSample(localX, localZ, coreMask);
  if (dune.erg <= 0.0) { return vec2f(0.0, 0.0); }
  return vec2f(dune.erg, terrainDuneSandCover(dune.erg, dune.duneHeight));
}

/**
 * applyTerrainLandforms (landforms.ts) at a point LOCAL to the bound page,
 * given the natural height the LAST terrainNaturalHeight call returned for
 * that same point (its kNatural intermediates are what the stages read):
 * natural -> dunes -> volcanic overlay. The airport earthworks follow in the
 * consumer.
 */
fn terrainLandforms(localX: f32, localZ: f32, natural: f32) -> f32 {
  let landform = terrainKernelPages[kPageIndex].landform;
  if (landform.z <= 0.0) { return natural; }
  let coreMask = terrainLandformCoreMask(localX, localZ);
  if (coreMask <= 0.0) { return natural; }
  let duned = terrainDuneStage(localX, localZ, natural, coreMask);
  return terrainVolcanicOverlay(
    terrainKernelPages[kPageIndex].landformBase,
    vec2f(localX, localZ),
    duned,
    terrainKernelPages[kPageIndex].kept.w,
  );
}
`;
