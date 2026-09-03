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

import type { TerrainKernelLattice } from "../terrain/TerrainKernel";
import {
  CANOPY_CLOSURE_FILTER_WIDTH_METERS,
  CANOPY_MEAN_CROWN_RADIUS_METERS,
  CANOPY_RENDERED_CROWN_AREA_RATIO,
  DETAIL_FAR_CULL_FADE_METERS,
  RIPARIAN_BANK_FADE_END_METERS,
  RIPARIAN_BANK_FADE_START_METERS,
  RIPARIAN_BANK_FULL_METERS,
  RIPARIAN_BANK_NEAR_METERS,
} from "./densityField";

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

/**
 * The six channels' OCTAVE counts, in `VEGETATION_DENSITY_LATTICES` order.
 *
 * `kFbm` reads `count` CONSECUTIVE lattice rows, so a multi-octave channel
 * occupies that many table slots and the base offsets below are cumulative —
 * not one slot per named channel, which is what the include assumed while it
 * was dead code and nothing composed it.
 */
const VEGETATION_LATTICE_OCTAVES: Readonly<Record<VegetationDensityLattice, number>> =
  Object.freeze({
    province: 3, glade: 2, succession: 2, windthrow: 1, shelter: 1, treelineWander: 2,
  });

/** Base index of a channel within the appended vegetation table. */
export function vegetationLatticeBase(channel: VegetationDensityLattice): number {
  let base = 0;
  for (const name of VEGETATION_DENSITY_LATTICES) {
    if (name === channel) return base;
    base += VEGETATION_LATTICE_OCTAVES[name];
  }
  throw new RangeError(`Unknown vegetation lattice ${channel}`);
}

export const VEGETATION_DENSITY_LATTICE_COUNT = VEGETATION_DENSITY_LATTICES.reduce(
  (sum, name) => sum + VEGETATION_LATTICE_OCTAVES[name],
  0,
);

/**
 * One channel's lattice rows, transliterated from the TypeScript call.
 *
 * Written out rather than reusing the kernel's `terrainKernelFbmRun` because
 * two of the six carry a divisor pair the helper cannot express: the province
 * and windthrow channels are ANISOTROPIC (7,200/5,400 m and 3,600/1,700 m) and
 * their band-limit key is the SMALLER period, exactly as the terrain kernel's
 * own fracture channels do it. Feeding the helper one base wavelength would
 * silently key the fade on the long axis and keep octaves the page cannot
 * carry.
 */
function vegetationLatticeRun(
  name: string,
  channel: number,
  octaves: number,
  divisorX: number,
  divisorZ: number,
  bandWavelengthMeters: number,
  shearFactor: number | null,
): TerrainKernelLattice[] {
  const run: TerrainKernelLattice[] = [];
  let frequency = 1;
  let amplitude = 1;
  let wavelength = bandWavelengthMeters;
  for (let octave = 0; octave < octaves; octave += 1) {
    run.push({
      name: octaves === 1 ? name : `${name}[${octave}]`,
      space: shearFactor === null ? "world" : "sheared",
      channel,
      // filteredValueNoise2D hashes the CHANNEL seed directly; fbm2D mixes
      // `octave + 1` on top of it.
      octaveChannel: octaves === 1 ? null : octave + 1,
      divisorX: divisorX / frequency,
      divisorZ: divisorZ / frequency,
      offsetX: 0,
      offsetZ: 0,
      wavelengthMeters: wavelength,
      amplitude,
      // The whole table is band-limited at ONE fixed width, not the page's.
      // See CANOPY_CLOSURE_FILTER_WIDTH_METERS: the closure channel is read
      // along a continuous surface at two different levels, so a per-page
      // width would make the same ground disagree with itself across a level
      // boundary — a crack, not a shimmer.
      filterWidthMetersOverride: CANOPY_CLOSURE_FILTER_WIDTH_METERS,
      ...(shearFactor === null ? {} : { shearFactor }),
    });
    amplitude *= 0.5;
    frequency *= 2;
    wavelength /= 2;
  }
  return run;
}

/**
 * `6-8`: the vegetation density field's lattices, appended to the terrain
 * kernel's own table by any consumer that composes
 * `VEGETATION_DENSITY_FIELD_WGSL`.
 *
 * The include's docblock always said the caller "appends these to the terrain
 * kernel's own lattice table and passes the base index"; this is that table,
 * and it lives on the VEGETATION side because the divisors, channels and
 * shears are `densityField.ts`'s, not the terrain kernel's.
 */
export const VEGETATION_DENSITY_KERNEL_LATTICES: readonly TerrainKernelLattice[] =
  Object.freeze([
    // fbm2D(mixSeed(seed, 75), (x + z·0.21)/7200, (z − x·0.21)/5400, 3, 2, 0.5, 5400)
    ...vegetationLatticeRun("vegProvince", 75, 3, 7_200, 5_400, 5_400, 0.21),
    // fbm2D(mixSeed(seed, 73), x/260, z/260, 2, 2, 0.5, 260)
    ...vegetationLatticeRun("vegGlade", 73, 2, 260, 260, 260, null),
    // fbm2D(mixSeed(seed, 74), x/1400, z/1400, 2, 2, 0.5, 1400)
    ...vegetationLatticeRun("vegSuccession", 74, 2, 1_400, 1_400, 1_400, null),
    // filteredValueNoise2D(mixSeed(seed, 76), (x + z·0.46)/3600, (z − x·0.46)/1700, 1700)
    ...vegetationLatticeRun("vegWindthrow", 76, 1, 3_600, 1_700, 1_700, 0.46),
    // filteredValueNoise2D(mixSeed(seed, 72), x/560, z/560, 560)
    ...vegetationLatticeRun("vegShelter", 72, 1, 560, 560, 560, null),
    // fbm2D(mixSeed(seed, 71), x/2400, z/2400, 2, 2, 0.5, 2400)
    ...vegetationLatticeRun("vegTreelineWander", 71, 2, 2_400, 2_400, 2_400, null),
  ]);

/** Injected so a corridor retune cannot move the TS half only (`6-6`). */
function wgslMeters(value: number): string {
  if (!Number.isFinite(value)) throw new RangeError("WGSL constants must be finite");
  return Number.isInteger(value) ? `${value}.0` : String(value);
}

/**
 * `6-9`: the ground-cover half of the density field, on its own.
 *
 * The archetype mix, canopy closure and grass cover are pure functions of a
 * handful of driver scalars: no lattice, no page uniform, no hash layer, no
 * terrain kernel beyond the three scalar helpers in
 * `TERRAIN_KERNEL_SCALAR_WGSL`. That is what lets the per-frame ground-cover
 * placement compute evaluate the SHIPPED law per lane at ~a dozen ALU rather
 * than compose an eleven-lattice noise field it would have to pay for at
 * 100 k invocations every frame.
 *
 * It is a separate export and NOT a copy: `VEGETATION_DENSITY_FIELD_WGSL`
 * composes this text, so the splat bake and the blade field call the same
 * functions, and `tests/render.webgpu-ground-cover-blades.test.ts` asserts
 * the composition rather than trusting it.
 */
export const VEGETATION_GROUND_COVER_LAW_WGSL = /* wgsl */ `
const VEG_CANOPY_MEAN_CROWN_AREA: f32 =
  ${(Math.PI * CANOPY_MEAN_CROWN_RADIUS_METERS ** 2).toFixed(6)};

/** Transliteration of densityField.ts's canopyClosure (Boolean crown model). */
fn vegetationCanopyClosure(treeStemsPerSquareMeter: f32) -> f32 {
  let area = max(0.0, treeStemsPerSquareMeter) * VEG_CANOPY_MEAN_CROWN_AREA;
  return 1.0 - exp(-area);
}

/**
 * The five-lane ground-cover archetype mix — densityField.ts's
 * groundCoverWeights, transliterated and normalised.
 *
 * 6-9 promoted this from the inside of the grass-share helper to a named
 * function with all five lanes, because the GPU ground-cover field now places
 * fern, heather and reed as well as grass and needs the same mix the card
 * path and the splat bake read. There is still exactly ONE archetype law in
 * WGSL: the grass helper below returns this vector's first lane rather than
 * recomputing it, so a retune cannot move the splat's answer without moving
 * the field's.
 *
 * Lane order matches GROUND_COVER_ARCHETYPES: grass, fern, heather, reed,
 * clutter. The clutter lane is computed here and consumed by nobody on the
 * GPU — it exists because the mix is normalised over all five, and dropping
 * it would silently renormalise every other lane upward.
 */
struct VegetationGroundCoverMix {
  grass: f32,
  fern: f32,
  heather: f32,
  reed: f32,
  clutter: f32,
};

fn vegetationGroundCoverWeights(
  moisture: f32,
  slope: f32,
  canopyShade: f32,
  elevationAboveSeaLevel: f32,
  riparianBand: f32,
) -> VegetationGroundCoverMix {
  let wet = kSmoothstep(0.42, 0.78, moisture);
  let dry = 1.0 - kSmoothstep(0.24, 0.55, moisture);
  let flat = 1.0 - kSmoothstep(0.04, 0.18, slope);
  let steep = kSmoothstep(0.12, 0.42, slope);
  let shade = kSaturate(canopyShade);
  let lowland = 1.0 - kSmoothstep(180.0, 700.0, elevationAboveSeaLevel);
  let bank = kSaturate(riparianBand);
  let grass = 0.35 + flat * 0.4 * (1.0 - shade);
  let fern = shade * (0.25 + wet * 0.75) + bank * (0.2 + shade * 0.45);
  let heather = dry * (0.2 + steep * 0.5) * (1.0 - lowland * 0.4);
  let reed = (wet + bank * 1.6) * flat * lowland * 0.9;
  let clutter = steep * 0.35 + shade * 0.2;
  let total = grass + fern + heather + reed + clutter;
  var result: VegetationGroundCoverMix;
  // OPEN_GRASSLAND_COVER, the TypeScript's own degenerate answer.
  if (total <= 0.0) {
    result.grass = 1.0;
    result.fern = 0.0;
    result.heather = 0.0;
    result.reed = 0.0;
    result.clutter = 0.0;
    return result;
  }
  result.grass = grass / total;
  result.fern = fern / total;
  result.heather = heather / total;
  result.reed = reed / total;
  result.clutter = clutter / total;
  return result;
}

/**
 * The grass archetype's SHARE of the ground-cover mix — the first lane of the
 * one law above, never a second copy of it.
 */
fn vegetationGrassArchetypeWeight(
  moisture: f32,
  slope: f32,
  canopyShade: f32,
  elevationAboveSeaLevel: f32,
  riparianBand: f32,
) -> f32 {
  return vegetationGroundCoverWeights(
    moisture, slope, canopyShade, elevationAboveSeaLevel, riparianBand).grass;
}

/** Absolute grass sward cover: the archetype share, suppressed by canopy. */
fn vegetationGrassCover(grassArchetypeWeight: f32, closure: f32) -> f32 {
  return kSaturate(grassArchetypeWeight) * (1.0 - kSaturate(closure));
}
`;

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
  // Signed metres to exported water edge; large positive is the neutral
  // pre-load/out-of-domain value.
  shoreDistanceMeters: f32,
  filterWidthMeters: f32,
};

struct VegetationDensitySample {
  treeStemsPerSquareMeter: f32,
  shrubStemsPerSquareMeter: f32,
  heightFactor: f32,
  forestFraction: f32,
  forestEdge: f32,
  // 6-6: the riparian bank band, the corridor shape the species half keys on.
  // Exposed for the same reason the TS sample exposes it — one shape, read by
  // the archetype weighting and the splat, never re-derived from the channel.
  riparianBand: f32,
  // 6-8: true crown cover, and the absolute grass sward the open part carries.
  canopyClosure: f32,
  grassCover: f32,
};
${VEGETATION_GROUND_COVER_LAW_WGSL}
const VEG_BASE_TREE_STEMS: f32 = 0.08;
const VEG_BASE_SHRUB_STEMS: f32 = 0.045;
const VEG_TREELINE_BASE_METERS: f32 = 1350.0;

/**
 * The two anisotropic channels arrive in SHEARED frames, exactly as the TS
 * does: the split origin is built in the sheared frame by the uniform builder,
 * and the page-local offset has to be sheared with it or a page's interior
 * drifts off the lattice by (shear · span / divisor) cells.
 */
fn vegetationShearedX(localX: f32, localZ: f32, shear: f32) -> f32 {
  return localX + localZ * shear;
}

fn vegetationShearedZ(localX: f32, localZ: f32, shear: f32) -> f32 {
  return localZ - localX * shear;
}

/** Multi-kilometre canopy gate: 0 is meadow, 1 is closed-forest province. */
fn vegetationForestFraction(base: u32, localX: f32, localZ: f32, moisture: f32) -> f32 {
  let px = vegetationShearedX(localX, localZ, 0.21);
  let pz = vegetationShearedZ(localX, localZ, 0.21);
  let province = kFbm(base + ${vegetationLatticeBase("province")}u, 3u, px, pz);
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
  if (shoreline <= 0.0 || drivers.shoreDistanceMeters <= 0.0) {
    result.treeStemsPerSquareMeter = 0.0;
    result.shrubStemsPerSquareMeter = 0.0;
    result.heightFactor = 1.0;
    result.forestFraction = 0.0;
    result.forestEdge = 0.0;
    result.riparianBand = 0.0;
    result.canopyClosure = 0.0;
    result.grassCover = 1.0;
    return result;
  }

  let province = vegetationForestFraction(base, localX, localZ, drivers.moisture);
  let gladeRaw = kFbm(base + ${vegetationLatticeBase("glade")}u, 2u, localX, localZ);
  let glade = 0.02 + 0.98 * kSmoothstep(-0.24, 0.02, gladeRaw);
  let successionRaw = kFbm(base + ${vegetationLatticeBase("succession")}u, 2u, localX, localZ);
  let succession = 1.0 - kSmoothstep(0.3, 0.48, successionRaw);
  let windthrowRaw = kFilteredNoise(
    base + ${vegetationLatticeBase("windthrow")}u,
    vegetationShearedX(localX, localZ, 0.46),
    vegetationShearedZ(localX, localZ, 0.46),
  );
  // One genuinely hard-edged class: real windthrow, burns and cuts do not all
  // dissolve through the same procedural softness.
  var windthrow = 1.0;
  if (windthrowRaw > 0.61) { windthrow = 0.0; }
  let disturbance = succession * windthrow;

  let provinceEdge = 1.0 - kSmoothstep(0.05, 0.22, abs(province - 0.5));
  let gladeEdge = 1.0 - kSmoothstep(0.025, 0.14, abs(gladeRaw + 0.11));
  let windthrowEdge = 1.0 - kSmoothstep(0.008, 0.045, abs(windthrowRaw - 0.61));
  let forestEdge = kSaturate(max(provinceEdge, max(gladeEdge * 0.7, windthrowEdge)));

  let shelter = kFilteredNoise(base + ${vegetationLatticeBase("shelter")}u, localX, localZ);
  let treelineWander = kFbm(
    base + ${vegetationLatticeBase("treelineWander")}u, 2u, localX, localZ);
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
  let channelClearance = kSmoothstep(0.0, 2.0, drivers.shoreDistanceMeters);
  let riparianBand = kSmoothstep(
      ${wgslMeters(RIPARIAN_BANK_NEAR_METERS)},
      ${wgslMeters(RIPARIAN_BANK_FULL_METERS)},
      drivers.shoreDistanceMeters,
    )
    * (1.0 - kSmoothstep(
      ${wgslMeters(RIPARIAN_BANK_FADE_START_METERS)},
      ${wgslMeters(RIPARIAN_BANK_FADE_END_METERS)},
      drivers.shoreDistanceMeters,
    ));

  let habitat = shoreline * slopeFactor * lapse * treelineFactor * aspectFactor
    * glade * disturbance * province * clearance * channelClearance
    * (1.0 + riparianBand * 0.2);
  result.treeStemsPerSquareMeter = kSaturate(VEG_BASE_TREE_STEMS * moistureFactor * habitat);

  let shrubMoisture = kSmoothstep(0.2, 0.5, drivers.moisture);
  let shrubSlope = 1.0 - kSmoothstep(0.09, 0.26, drivers.slope);
  let shrubTreeline = 1.0 - kSmoothstep(treeline - 80.0, treeline + 140.0, elevation);
  let openness = 0.45 + 0.55 * (1.0 - glade * 0.7);
  let shrubForestGate = 0.28 + province * 0.72;
  let edgeShrubGain = 1.0 + forestEdge * 0.45;
  result.shrubStemsPerSquareMeter = kSaturate(
    VEG_BASE_SHRUB_STEMS * shrubMoisture * shrubSlope * shrubTreeline * openness
      * shoreline * disturbance * shrubForestGate * edgeShrubGain * clearance
      * channelClearance * (1.0 + riparianBand * 0.65),
  );
  result.heightFactor = heightFactor * (1.0 - forestEdge * 0.34);
  result.forestFraction = province;
  result.forestEdge = forestEdge;
  result.riparianBand = riparianBand;
  result.canopyClosure = vegetationCanopyClosure(result.treeStemsPerSquareMeter);
  result.grassCover = vegetationGrassCover(
    vegetationGrassArchetypeWeight(
      drivers.moisture,
      drivers.slope,
      // Canopy closure IS the shade term, exactly as the TS says.
      kSaturate(result.treeStemsPerSquareMeter / VEG_BASE_TREE_STEMS),
      elevation,
      riparianBand,
    ),
    result.canopyClosure,
  );
  return result;
}
`;

/**
 * `6-8`: the canopy/terrain handoff, in WGSL — the half the TERRAIN material
 * composes.
 *
 * Deliberately separate from the density include above: the handoff needs no
 * lattices, no page uniform and no terrain kernel, only the one baked closure
 * scalar and the tier's band radii. Terrain reaches it through the same single
 * sanctioned entry point as everything else in this file's authority, and
 * `densityField.ts`'s `canopyRenderedShare`/`canopyHandoff` are the TypeScript
 * the parity test compares against.
 *
 * Requires `kSaturate` and `kSmoothstep`… nothing else. It is composed into the
 * terrain surface plugin, which has neither, so it carries its own clamp.
 */
export const VEGETATION_CANOPY_HANDOFF_WGSL = /* wgsl */ `
// Crown area per m² the near band can render before rank thinning saturates.
const VEG_CANOPY_RENDERED_AREA: f32 =
  ${CANOPY_RENDERED_CROWN_AREA_RATIO.toFixed(6)};
// The impostor band's outer dither window — DetailInstanceMaterialPlugin's
// band-code-2 fade, read from the SAME constant so the two cannot drift.
const VEG_CANOPY_CULL_FADE_METERS: f32 = ${DETAIL_FAR_CULL_FADE_METERS.toFixed(1)};

struct VegetationCanopyHandoff {
  // Crown cover the DRAWN stems supply at this range.
  renderedCover: f32,
  // Crown cover they do not: closure - renderedCover, by construction.
  deficit: f32,
  // The half you stand under (QR-2's dappled shade).
  shade: f32,
  // The half you look at (the far-field canopy surface).
  surface: f32,
};

/**
 * The share of the canopy's crown area rendered stems still supply at a range.
 *
 * bands = (near radius, far/impostor radius, far floor share, unused).
 * Both factors are LIVE mechanisms: renderedDensity.ts's inverse-square
 * falloff with its floor, and the impostor band's outer dither fade.
 */
/**
 * The impostor band's outer dither survival alone: 1 while the far band draws,
 * 0 once it has dithered out.
 *
 * The GEOMETRY half of the handoff keys on THIS, not on the whole rendered
 * share. Appearance may take over inside the geometry bands - a forest at
 * 400 m reads as canopy between its thinned stems. Height may not: stems stand
 * on the unlifted terrain, so lifting ground that still carries drawn trees
 * would sink them into it. Canopy volume is added exactly where no canopy
 * volume is drawn.
 */
fn vegetationCanopyImpostorCull(rangeMeters: f32, bands: vec4f) -> f32 {
  return clamp((bands.y - rangeMeters) / VEG_CANOPY_CULL_FADE_METERS, 0.0, 1.0);
}

fn vegetationCanopyRenderedShare(rangeMeters: f32, bands: vec4f) -> f32 {
  var falloff = 1.0;
  if (rangeMeters > bands.x) {
    let ratio = bands.x / max(rangeMeters, 1e-3);
    falloff = max(ratio * ratio, bands.z);
  }
  return clamp(
    falloff * vegetationCanopyImpostorCull(rangeMeters, bands), 0.0, 1.0);
}

/** Metres of canopy the ground carries, before the consumer's Nyquist gate. */
fn vegetationCanopyLiftMeters(closure: f32, rangeMeters: f32, bands: vec4f) -> f32 {
  return bands.w * clamp(closure, 0.0, 1.0)
    * (1.0 - vegetationCanopyImpostorCull(rangeMeters, bands));
}

/**
 * Split one closure value between the two representations.
 *
 * renderedCover + deficit == closure identically, and shade + surface ==
 * deficit identically: the residual is DEFINED as the residual rather than
 * tuned to meet it, which is what makes coverage conserved instead of
 * approximately conserved. Continuous in range because the share is.
 */
fn vegetationCanopyHandoff(closure: f32, share: f32) -> VegetationCanopyHandoff {
  var result: VegetationCanopyHandoff;
  let cover = clamp(closure, 0.0, 1.0);
  let s = clamp(share, 0.0, 1.0);
  let areaAll = -log(max(1e-4, 1.0 - cover));
  let areaRendered = min(areaAll, VEG_CANOPY_RENDERED_AREA);
  result.renderedCover = 1.0 - exp(-areaRendered * s);
  result.deficit = max(0.0, cover - result.renderedCover);
  result.shade = result.deficit * s;
  result.surface = result.deficit * (1.0 - s);
  return result;
}
`;
