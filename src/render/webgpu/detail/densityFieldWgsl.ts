/**
 * The vegetation density field, in WGSL (`4-6b`, D12).
 *
 * INVARIANT THIS FILE OWNS: **one shared include, consumed by both the
 * land-cover classifier's page bake and the vegetation path — never a copy.**
 * `densityField.ts` remains the authority; this is its transliteration, and it
 * lives in its own file with its own owner row precisely so that a second
 * "where is forest?" cannot appear inside a shader where nobody would look for
 * it.
 *
 * The whole reason it takes a filter width is the defect D12 names: the glade
 * channel has a 260 m lattice, and point-sampling it onto a level-5 page whose
 * texels are 128 m apart re-rolls an arbitrary phase per level. The symptom is
 * canopy cover that CHANGES when a page changes LOD — the same defect `1B-2`
 * fixed for height, one system over.
 *
 * Requires `kSmoothstep`, `kSaturate` and the filtered-noise helpers from the
 * terrain kernel include, plus a `vegetationDensityLattices` uniform whose
 * split origins were built the same way the kernel's page uniform is.
 */

/** Lattice slots the include indexes, in order. */
export const VEGETATION_DENSITY_LATTICES = [
  "province",
  "glade",
  "succession",
  "windthrow",
  "shelter",
  "treelineWander",
] as const;

export type VegetationDensityLattice = (typeof VEGETATION_DENSITY_LATTICES)[number];

export const VEGETATION_DENSITY_FIELD_WGSL = /* wgsl */ `
// ---------------------------------------------------------------------------
// Transliteration of src/render/webgpu/detail/densityField.ts. The TypeScript
// is the authority; this is the same arithmetic on the same lattices, so a
// page bake and a per-stem placement cannot disagree about where forest is.
//
// Lattice indices are the caller's: it appends these to the terrain kernel's
// own lattice table and passes the base index, so the split-origin machinery
// is shared rather than duplicated.
// ---------------------------------------------------------------------------

struct VegetationDensityDrivers {
  elevationAboveSeaLevel: f32,
  slope: f32,
  moisture: f32,
  aspect: f32,
  airportInfluence: f32,
  filterWidthMeters: f32,
};

struct VegetationDensitySample {
  treeStemsPerSquareMeter: f32,
  shrubStemsPerSquareMeter: f32,
  heightFactor: f32,
  forestFraction: f32,
  forestEdge: f32,
};

const VEG_BASE_TREE_STEMS: f32 = 0.08;
const VEG_BASE_SHRUB_STEMS: f32 = 0.045;
const VEG_TREELINE_BASE_METERS: f32 = 1350.0;

/** Multi-kilometre canopy gate: 0 is meadow, 1 is closed-forest province. */
fn vegetationForestFraction(base: u32, localX: f32, localZ: f32, moisture: f32) -> f32 {
  let province = kFbm(base + 0u, 3u, localX, localZ);
  return kSmoothstep(-0.22, 0.2, province + (moisture - 0.55) * 0.7);
}

fn vegetationDensity(
  base: u32,
  localX: f32,
  localZ: f32,
  drivers: VegetationDensityDrivers,
) -> VegetationDensitySample {
  var result: VegetationDensitySample;
  let elevation = drivers.elevationAboveSeaLevel;
  let shoreline = kSmoothstep(1.5, 7.0, elevation);
  if (shoreline <= 0.0) {
    result.treeStemsPerSquareMeter = 0.0;
    result.shrubStemsPerSquareMeter = 0.0;
    result.heightFactor = 1.0;
    result.forestFraction = 0.0;
    result.forestEdge = 0.0;
    return result;
  }

  let province = vegetationForestFraction(base, localX, localZ, drivers.moisture);
  let gladeRaw = kFbm(base + 1u, 2u, localX, localZ);
  let glade = 0.02 + 0.98 * kSmoothstep(-0.24, 0.02, gladeRaw);
  let successionRaw = kFbm(base + 2u, 2u, localX, localZ);
  let succession = 1.0 - kSmoothstep(0.3, 0.48, successionRaw);
  let windthrowRaw = kFilteredNoise(base + 3u, localX, localZ);
  // One genuinely hard-edged class: real windthrow, burns and cuts do not all
  // dissolve through the same procedural softness.
  var windthrow = 1.0;
  if (windthrowRaw > 0.61) { windthrow = 0.0; }
  let disturbance = succession * windthrow;

  let provinceEdge = 1.0 - kSmoothstep(0.05, 0.22, abs(province - 0.5));
  let gladeEdge = 1.0 - kSmoothstep(0.025, 0.14, abs(gladeRaw + 0.11));
  let windthrowEdge = 1.0 - kSmoothstep(0.008, 0.045, abs(windthrowRaw - 0.61));
  let forestEdge = kSaturate(max(provinceEdge, max(gladeEdge * 0.7, windthrowEdge)));

  let shelter = kFilteredNoise(base + 4u, localX, localZ);
  let treelineWander = kFbm(base + 5u, 2u, localX, localZ);
  let treeline = VEG_TREELINE_BASE_METERS
    + drivers.aspect * 120.0 + shelter * 80.0 + treelineWander * 90.0;
  let treelineFactor = 1.0 - kSmoothstep(treeline - 220.0, treeline + 40.0, elevation);
  let heightFactor = kClamp(
    1.0 - kSmoothstep(treeline - 320.0, treeline - 30.0, elevation) * 0.88,
    0.12,
    1.0,
  );

  let moistureFactor = pow(kSmoothstep(0.3, 0.62, drivers.moisture), 1.6);
  let slopeFactor = 1.0 - kSmoothstep(0.05, 0.212, drivers.slope);
  let lapse = 1.0 - kSmoothstep(500.0, max(501.0, treeline), elevation) * 0.45;
  let aspectFactor = 1.0 - drivers.aspect * 0.25;
  let clearance = 1.0 - kSaturate(drivers.airportInfluence);

  let habitat = shoreline * slopeFactor * lapse * treelineFactor * aspectFactor
    * glade * disturbance * province * clearance;
  result.treeStemsPerSquareMeter = kSaturate(VEG_BASE_TREE_STEMS * moistureFactor * habitat);

  let shrubMoisture = kSmoothstep(0.2, 0.5, drivers.moisture);
  let shrubSlope = 1.0 - kSmoothstep(0.09, 0.26, drivers.slope);
  let shrubTreeline = 1.0 - kSmoothstep(treeline - 80.0, treeline + 140.0, elevation);
  let openness = 0.45 + 0.55 * (1.0 - glade * 0.7);
  let shrubForestGate = 0.28 + province * 0.72;
  let edgeShrubGain = 1.0 + forestEdge * 0.45;
  result.shrubStemsPerSquareMeter = kSaturate(
    VEG_BASE_SHRUB_STEMS * shrubMoisture * shrubSlope * shrubTreeline * openness
      * shoreline * disturbance * shrubForestGate * edgeShrubGain * clearance,
  );
  result.heightFactor = heightFactor * (1.0 - forestEdge * 0.34);
  result.forestFraction = province;
  result.forestEdge = forestEdge;
  return result;
}
`;
