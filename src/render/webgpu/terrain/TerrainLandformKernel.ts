import { StorageBuffer } from "@babylonjs/core/Buffers/storageBuffer";
import type { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { CLIMATE_PROVINCE } from "@/src/world/climateProvince";
import { DUNE_PROFILE_CONSTANTS, DUNES } from "@/src/world/dunes";
import { FRACTURE_EXPOSURE_MEAN, FRACTURE_RAVINE_MEAN } from "@/src/world/geology";
import {
  LOCAL_RIDGES_KNOLL_MEAN,
  RIDGES_INVERSE_POW_31_MEAN,
  RIDGES_POW_212_MEAN,
} from "@/src/world/terrain";
import { terrainKernelLatticeBase } from "./TerrainKernel";

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
 * Bytes of the placeholder `terrainLandformData` buffer: one zero `vec4f`, on
 * which `terrainVolcanicActivity` is exactly 0.0. Every consumer binds one
 * until the volcanic overlay owns the buffer.
 */
export const TERRAIN_LANDFORM_DATA_PLACEHOLDER_BYTES = 16;

/**
 * The landform data binding a consumer prepends. A generic array the volcanic
 * overlay will fill (a site index); the stub below reads element 0 so the
 * binding stays reachable.
 */
export function terrainLandformDataBindingWgsl(group: number, binding: number): string {
  return /* wgsl */ `
@group(${group}) @binding(${binding}) var<storage, read> terrainLandformData: array<vec4f>;
`;
}

/**
 * The zeroed one-`vec4f` placeholder. The caller registers
 * `TERRAIN_LANDFORM_DATA_PLACEHOLDER_BYTES` with the GPU buffer inventory (Gate
 * 0-c), like its other fixed buffers, and disposes it with them.
 */
export function createTerrainLandformPlaceholderBuffer(engine: WebGPUEngine): StorageBuffer {
  const buffer = new StorageBuffer(engine, TERRAIN_LANDFORM_DATA_PLACEHOLDER_BYTES);
  // WebGPU zero-initialises buffers; writing the zeros states the contract
  // `terrainVolcanicActivity` depends on instead of inheriting it.
  buffer.update(new Float32Array(TERRAIN_LANDFORM_DATA_PLACEHOLDER_BYTES / 4));
  return buffer;
}

export const TERRAIN_LANDFORM_WGSL = /* wgsl */ `
// ---------------------------------------------------------------------------
// Landforms — TRANSLITERATION of src/world/{landforms,dunes}.ts. Generated by
// src/render/webgpu/terrain/TerrainLandformKernel.ts.
//
// Requires, before it: terrainKernelPageBindingWgsl(...),
// terrainLandformDataBindingWgsl(...) and TERRAIN_KERNEL_WGSL.
// ---------------------------------------------------------------------------

// ===== VOLCANIC HOOK 1 of 2 — the volcanic include replaces this stub =====
/**
 * volcanicActivity (landforms.ts), in [0, 1]: a stub returning 0 until the
 * volcanic overlay lands. Sand seas are multiplied by (1.0 - activity), so the
 * two landforms never stack. It READS terrainLandformData so the binding stays
 * reachable: Tint prunes a binding no live code reads, and Babylon then
 * dispatches against a bindingsMapping entry that no longer exists. Over the
 * zeroed placeholder kSaturate(0.0) is exactly 0.0, so the dune weight's
 * (1.0 - activity) is exactly 1.0.
 */
fn terrainVolcanicActivity(localX: f32, localZ: f32) -> f32 {
  return kSaturate(terrainLandformData[0].x);
}

// ===== VOLCANIC HOOK 2 of 2 — the volcanic include replaces this stub =====
/**
 * The volcanic overlay: the stage after the dunes. base is the page's
 * landformBase row (the page origin minus the landform core's centre, split
 * hi/lo in f64), local the point's offset from the page origin, and
 * filterWidth the page's band-limit half-width (kept.w). A stub returning
 * the height it was given, the same number.
 */
fn terrainVolcanicOverlay(base: vec4f, local: vec2f, height: f32, filterWidth: f32) -> f32 {
  return height;
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
    // unmaskedProvinceDryness: the dryness half of the unmasked province.
    let dryness = kProvinceDrynessStaircase(
      kFbm(${terrainKernelLatticeBase("provinceDryness")}u, ${CLIMATE_PROVINCE.dryness.octaves}u, localX, localZ));
    weight = weight * kSmoothstep(KL_ARID_DRYNESS_LOW, KL_ARID_DRYNESS_HIGH, dryness);
    if (weight <= 0.0) { return 0.0; }
    weight = weight * kSmoothstep(
      KL_ERG_PATCH_LOW,
      KL_ERG_PATCH_HIGH,
      kFbm(${terrainKernelLatticeBase("duneErgPatch")}u, ${DUNES.ergPatch.octaves}u, localX, localZ),
    );
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

/**
 * applyDuneStage: height itself (the same number, not + 0.0) wherever the
 * erg weight is 0; inside a sand sea the flattened floor plus the dune field.
 */
fn terrainDuneStage(localX: f32, localZ: f32, height: f32, coreMask: f32) -> f32 {
  let relief = terrainDuneRelief();
  let erg = terrainDuneErgWeight(localX, localZ, coreMask, relief);
  if (erg <= 0.0) { return height; }
  let duneHeight = terrainDuneField(localX, localZ, erg);
  return height + terrainDuneFloorFlattening(erg, relief) + duneHeight;
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
  // landformCoreMask: the page origin's offset from the core's centre was
  // subtracted in f64, so only a local-sized vector reaches this length().
  let radii = terrainKernelPages[kPageIndex].landformRadii;
  let coreMask = kSmoothstep(radii.x, radii.y, length(landform.xy + vec2f(localX, localZ)));
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
