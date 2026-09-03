import {
  blendTowardExpectation,
  filteredValueNoise2D,
  ridgedChannelVarianceKept,
  ridgedFbm2D,
  saturate,
  smoothstep,
} from "./noise";
import { hashLatticeCoordinates, mixSeed } from "./seed";

/**
 * Full-bandwidth expectations of this file's nonlinear ridge composites,
 * measured 2026-08-17 over 250k samples spanning ~2000 lattice cells.
 *
 * Named and exported since `4-1`: the WGSL transliteration injects them from
 * here. They were inline literals, which is exactly how a retyped digit would
 * move coarse-page mean height by metres without failing a parity test run at
 * `filterWidth = 0`.
 */
export const FRACTURE_EXPOSURE_MEAN = 0.1296;
export const FRACTURE_RAVINE_MEAN = 0.2099;
/** The talus channel's full-bandwidth mean, subtracted so it adds no bias. */
export const TALUS_RIDGES_MEAN = 0.58;

/**
 * Adds the short-wavelength relief that broad continental and mountain fields
 * cannot provide on their own. Inputs are the already-computed land/uplift
 * masks, keeping this addition bounded and preserving open lowland.
 *
 * `filterWidthMeters` follows the coordinates by the shared kernel convention
 * (see sampleNaturalTerrainHeight). It is a required no-op until 1B-2 lands
 * band-limiting; 0 means the full-bandwidth field.
 */
export function sampleGeologicalRelief(
  seedHash: number,
  x: number,
  z: number,
  filterWidthMeters: number,
  land: number,
  foothillRegion: number,
  mountainRegion: number,
): number {
  if (!Number.isFinite(filterWidthMeters) || filterWidthMeters < 0) {
    throw new RangeError("filterWidthMeters must be finite and non-negative");
  }
  if (land <= 0.0001) return 0;

  // Subtle metre-scale undulation prevents plains from becoming mathematically
  // smooth while remaining gentle enough for off-airport ground contact.
  const groundNoise = filteredValueNoise2D(mixSeed(seedHash, 141), x / 105, z / 105, 105, filterWidthMeters);
  const groundRoughness =
    groundNoise * land * (1.7 + foothillRegion * 7.5 + mountainRegion * 5.5);

  // The render grid previously had no geometric energy between roughly 100 m
  // geological noise and sub-metre shader normals. A restrained 35--70 m band
  // gives low flight and taxi views real undulation while remaining gentle
  // enough for off-airport contact. Airport flattening is applied after this
  // shared natural-height kernel, so paved starts stay physically level.
  const soilUndulation = filteredValueNoise2D(
    mixSeed(seedHash, 144),
    x / 43,
    z / 43,
    43,
    filterWidthMeters,
  );
  const smallRelief = soilUndulation * land *
    (0.7 + foothillRegion * 1.8 + mountainRegion * 1.2);

  // An anisotropic ridge field creates elongated rock ribs rather than round
  // noise bumps. Three octaves reach down to roughly 100 m, matching the near
  // render grid while still contributing broken silhouettes to the mid LOD.
  const rotatedX = x * 0.819 + z * 0.574;
  const rotatedZ = -x * 0.574 + z * 0.819;
  // Anisotropic channels key their fade on the smaller period: at a footprint
  // where the short axis aliases, the whole channel fades rather than alias.
  const fractureRidges = ridgedFbm2D(
    mixSeed(seedHash, 142),
    rotatedX / 390,
    rotatedZ / 980,
    3,
    390,
    filterWidthMeters,
  );
  const fractureVariation = filteredValueNoise2D(
    mixSeed(seedHash, 143),
    rotatedX / 155,
    rotatedZ / 240,
    155,
    filterWidthMeters,
  );
  // The fracture channel rests at 0.4491 when fully faded — just below the
  // 0.49 exposure threshold, which without correction erases the entire mean
  // outcrop lift on coarse pages. Both composites blend toward their measured
  // full-bandwidth expectations (2026-08-17, 250k samples over ~2000 lattice
  // cells) as texture fades.
  const fractureKept = ridgedChannelVarianceKept(3, 390, filterWidthMeters);
  const exposure = smoothstep(0.49, 0.84, fractureRidges);
  const upliftMask = foothillRegion * 0.52 + mountainRegion * 0.78;
  // The blend wraps the whole term (identical arithmetic order when the
  // channel is fully alive, so width 0 stays bit-identical); the resting term
  // is the same product with the composite at its measured expectation.
  const outcropLift = blendTowardExpectation(
    land *
      upliftMask *
      exposure *
      (17 + mountainRegion * 66) *
      (0.82 + fractureVariation * 0.18),
    land * upliftMask * FRACTURE_EXPOSURE_MEAN * (17 + mountainRegion * 66),
    fractureKept,
  );

  // The complementary troughs read as gullies and talus channels. They keep
  // the positive ribs from merely inflating the whole mountain mass.
  const ravineSignal = blendTowardExpectation(
    Math.pow(Math.max(0, 1 - fractureRidges), 3.2),
    FRACTURE_RAVINE_MEAN,
    fractureKept,
  );
  const ravineCarve =
    land *
    (foothillRegion * 0.32 + mountainRegion * 0.7) *
    ravineSignal *
    (9 + mountainRegion * 48);

  const talusRidges = ridgedFbm2D(
    mixSeed(seedHash, 145),
    rotatedX / 120,
    rotatedZ / 280,
    2,
    120,
    filterWidthMeters,
  );
  const talusMeanRemoved = (talusRidges - TALUS_RIDGES_MEAN) *
    land * (foothillRegion * 2.8 + mountainRegion * 7.6);

  return groundRoughness + smallRelief + outcropLift - ravineCarve + talusMeanRemoved;
}

// ---------------------------------------------------------------------------
// `W-4` (Phase 6, Gate W, register C-4): the Lloyd-relaxed plate model
// ---------------------------------------------------------------------------

/**
 * Plate tessellation for the eroded world's tectonic uplift.
 *
 * WHY IT EXISTS. The shipped uplift derived `convergence` from two seeded
 * noise fields — a 96 km ridged "plate boundary" times a 210 km "relative
 * motion" — so convergence strength was a property of WHERE YOU STOOD, not of
 * a boundary between two moving plates. W-7 measured the consequence on
 * assertion 96's local half: range-local gradient anisotropy reaches 2:1 in
 * only 76% of ranges (median 2.430:1, weakest 1.394:1), because a range that
 * happens to sit away from a strong noise maximum gets a weak grain and its
 * relief comes from the isotropic rolling/foothill channels instead.
 *
 * Here a range is uplifted BY a boundary: every plate carries a motion vector,
 * every boundary between two plates carries their closing rate, and the uplift
 * a point receives is the sum over the nearby bisectors of (closing rate x
 * proximity). A boundary that closes at all closes along its whole length, so
 * every range it raises inherits the same across-strike grain.
 *
 * LLOYD RELAXATION, IN A POINTWISE KERNEL. A centroidal Voronoi tessellation
 * cannot be iterated at sample time, but one explicit Lloyd step has a closed
 * form on a jittered lattice: the centroid of a cell is approximately the mean
 * of the site and the midpoints to its neighbours, so
 *
 *     site' = site + (lambda/2) * (mean4(neighbour sites) - site)
 *
 * and because the lattice term of `mean4(neighbour sites)` is exactly the
 * cell's own lattice position, that reduces to a Laplacian smoothing of the
 * JITTER field alone. One step at lambda = 1 is `0.5 * self + 0.5 * mean4`,
 * which is what this file applies: cells become measurably more equal-area
 * (jitter standard deviation drops to 0.56x) without a single extra lattice
 * evaluation beyond the 21 the 3x3 search already needs.
 *
 * The 0.30-cell jitter bound is not a taste constant: a 3x3 candidate block is
 * PROVABLY sufficient only while `1.5 - J > sqrt(2) * (0.5 + J)`, i.e.
 * `J < 0.328`. Raising it would silently make the nearest-site search wrong
 * near cell corners. The Lloyd step only shrinks the jitter, so the bound
 * survives relaxation.
 *
 * No sin-fract hashing anywhere: sites, motions and speeds all come from the
 * shared integer lattice hash, which is exact at world scale (the plate
 * lattice index at 1,000 km out is 10, not a float that has lost its low bits).
 */
export const TERRAIN_PLATE_CELL_METERS = 96_000;
/** Jitter half-width in cells; see the 3x3-sufficiency bound above. */
export const TERRAIN_PLATE_JITTER_CELLS = 0.3;
/**
 * Radius, in cells, over which a plate's site still weights a boundary.
 *
 * Load-bearing twice. It is the belt's ALONG-STRIKE reach — a pair of sites
 * only raises a range where the sample is near both. And it is what makes the
 * 3x3 block closed: a cell outside the block is at least `1 + 1 - 0.5 - J =
 * 1.2` cells from any sample in the base cell, so a reach of 1.15 gives every
 * excluded cell weight EXACTLY zero and the field stays continuous across the
 * lattice step. Raising it past 1.2 would put a discontinuity on every cell
 * boundary in the world.
 */
export const TERRAIN_PLATE_SITE_REACH_CELLS = 1.15;
export const TERRAIN_PLATE_SITE_PLATEAU_CELLS = 0.5;
/** Half-width of a boundary's uplift influence across strike, in cells. */
export const TERRAIN_PLATE_BOUNDARY_WIDTH_CELLS = 0.22;
/** Scales the closing rate (in plate-speed units) into the [0,1] convergence. */
export const TERRAIN_PLATE_CLOSING_SCALE = 0.5;

/** Exported since `W-4`: the WGSL twin hoists both mixes from here. */
export const TERRAIN_PLATE_SITE_CHANNEL = 160;
export const TERRAIN_PLATE_MOTION_CHANNEL = 161;
/**
 * Both jitter/motion components come from ONE lattice hash, read as two 16-bit
 * halves. Sixteen bits is 1.5 m of positional resolution on a 96 km cell, and
 * `n / 65536` is exactly representable in f32, so the GPU twin reproduces the
 * site positions bit-for-bit instead of to a tolerance.
 */
export const TERRAIN_PLATE_HASH_16BIT_SCALE = 1 / 65_536;
/** 3x3 candidate cells; their Lloyd step reads the 5x5 raw-jitter block. */
const PLATE_BLOCK = 3;
const PLATE_RAW_BLOCK = 5;

/**
 * The plate model's per-sample state. Coordinates are in CELLS throughout;
 * only the caller converts to metres, which keeps every comparison in the
 * numeric range f32 represents densely.
 */
export interface TerrainPlateSample {
  /** Summed closing rate x boundary proximity, saturated into [0, 1]. */
  readonly convergence: number;
}

/*
 * MEASURED DEAD END, recorded so it is not retried blind. This sampler also
 * returned a contribution-weighted, double-angle-encoded ACROSS-STRIKE
 * direction, intended to rotate the anisotropic range channel into the frame
 * of the boundary that raised it. Implemented and measured 2026-08-30 on the
 * W-7 statistics suite: assertion 96's local half got WORSE — median range
 * anisotropy 2.913 -> 2.050, share reaching 2:1 78% -> 50% — because the
 * boundary normal turns from one site pair to the next and is therefore LESS
 * coherent inside a 16 km window than the 96 km seeded fabric it replaced. The
 * output is removed rather than left unread: an unconsumed field would have to
 * be transliterated into the WGSL twin and pinned by the parity criteria for
 * nothing.
 */

/**
 * Per-call scratch. Reused rather than allocated because the uplift kernel
 * runs once per erosion-scratch texel (147,456 per page) and this is a pure
 * function whose results never alias it — the same reason
 * `sampleTerrainEvolutionGeology` takes a caller-owned target.
 */
const PLATE_SCRATCH = {
  rawJitterX: new Float64Array(PLATE_RAW_BLOCK * PLATE_RAW_BLOCK),
  rawJitterZ: new Float64Array(PLATE_RAW_BLOCK * PLATE_RAW_BLOCK),
  siteX: new Float64Array(PLATE_BLOCK * PLATE_BLOCK),
  siteZ: new Float64Array(PLATE_BLOCK * PLATE_BLOCK),
  motionX: new Float64Array(PLATE_BLOCK * PLATE_BLOCK),
  motionZ: new Float64Array(PLATE_BLOCK * PLATE_BLOCK),
  weight: new Float64Array(PLATE_BLOCK * PLATE_BLOCK),
  active: new Int32Array(PLATE_BLOCK * PLATE_BLOCK),
};

/**
 * Plate convergence at a world point.
 *
 * NO NEAREST-SITE SELECTION. An earlier form of this function found the
 * nearest site and summed over ITS neighbours; that is discontinuous, and
 * measurably so — 0.972 of full scale between adjacent 512 m macro texels at
 * triple junctions, where the set of pairs changes identity while every pair
 * still carries full boundary weight. A landscape cannot have a cliff there.
 * The shipped form weights every PAIR of nearby sites by both sites' own
 * smooth, compactly-supported reach, so no term ever appears or vanishes
 * abruptly and the answer never depends on a comparison's outcome.
 *
 * `filterWidthMeters` is accepted for signature parity with the rest of the
 * kernel and is deliberately unused: the field's finest feature is a boundary
 * tens of kilometres wide, three orders of magnitude above any page footprint,
 * so band-limiting it would be a no-op that only cost a smoothstep. Passing a
 * width must not change the answer, and it does not.
 */
export function sampleTerrainPlates(
  seedHash: number,
  x: number,
  z: number,
  filterWidthMeters: number,
): TerrainPlateSample {
  if (!Number.isFinite(x) || !Number.isFinite(z)) {
    throw new RangeError("Plate sample coordinates must be finite");
  }
  if (!Number.isFinite(filterWidthMeters) || filterWidthMeters < 0) {
    throw new RangeError("filterWidthMeters must be finite and non-negative");
  }
  const siteHash = mixSeed(seedHash, TERRAIN_PLATE_SITE_CHANNEL);
  const motionHash = mixSeed(seedHash, TERRAIN_PLATE_MOTION_CHANNEL);
  const pointX = x / TERRAIN_PLATE_CELL_METERS;
  const pointZ = z / TERRAIN_PLATE_CELL_METERS;
  const baseX = Math.floor(pointX);
  const baseZ = Math.floor(pointZ);
  // SPLIT ORIGIN (TerrainKernel rule 1), applied to the plate lattice: every
  // position below is held RELATIVE to the base cell, so the arithmetic stays
  // in [-2, 3] instead of near 27 at the world's edge. `p - floor(p)` is exact
  // in binary floating point, so the split costs nothing and it is what lets
  // the f32 WGSL twin agree with this f64 original at wrap radius.
  const localX = pointX - baseX;
  const localZ = pointZ - baseZ;
  const scratch = PLATE_SCRATCH;

  // 1. Raw jitter over the 5x5 block: one hash per cell, split into halves.
  const jitterScale = 2 * TERRAIN_PLATE_JITTER_CELLS;
  for (let row = 0; row < PLATE_RAW_BLOCK; row += 1) {
    for (let column = 0; column < PLATE_RAW_BLOCK; column += 1) {
      const hash = hashLatticeCoordinates(siteHash, baseX + column - 2, baseZ + row - 2);
      const slot = row * PLATE_RAW_BLOCK + column;
      scratch.rawJitterX[slot] =
        (((hash >>> 16) & 0xffff) * TERRAIN_PLATE_HASH_16BIT_SCALE - 0.5) * jitterScale;
      scratch.rawJitterZ[slot] = ((hash & 0xffff) * TERRAIN_PLATE_HASH_16BIT_SCALE - 0.5) * jitterScale;
    }
  }

  // 2. One explicit Lloyd step: 0.5 * own jitter + 0.5 * mean of four
  //    neighbours', which is the closed form derived in the file docblock.
  let activeCount = 0;
  for (let row = 0; row < PLATE_BLOCK; row += 1) {
    for (let column = 0; column < PLATE_BLOCK; column += 1) {
      const centre = (row + 1) * PLATE_RAW_BLOCK + column + 1;
      const slot = row * PLATE_BLOCK + column;
      const siteX = column - 1 + 0.5
        + scratch.rawJitterX[centre]! * 0.5
        + (scratch.rawJitterX[centre - 1]! + scratch.rawJitterX[centre + 1]!
          + scratch.rawJitterX[centre - PLATE_RAW_BLOCK]!
          + scratch.rawJitterX[centre + PLATE_RAW_BLOCK]!) * 0.125;
      const siteZ = row - 1 + 0.5
        + scratch.rawJitterZ[centre]! * 0.5
        + (scratch.rawJitterZ[centre - 1]! + scratch.rawJitterZ[centre + 1]!
          + scratch.rawJitterZ[centre - PLATE_RAW_BLOCK]!
          + scratch.rawJitterZ[centre + PLATE_RAW_BLOCK]!) * 0.125;
      scratch.siteX[slot] = siteX;
      scratch.siteZ[slot] = siteZ;
      const weight = 1 - smoothstep(
        TERRAIN_PLATE_SITE_PLATEAU_CELLS,
        TERRAIN_PLATE_SITE_REACH_CELLS,
        Math.hypot(siteX - localX, siteZ - localZ),
      );
      scratch.weight[slot] = weight;
      if (weight <= 0) continue;
      // Plate motion: one hash read as a point in the unit square, shrunk to
      // the unit disc only when it lies outside. Direction and speed share one
      // hash and need no trigonometry at all. Sampled lazily, so a plate whose
      // site cannot reach this point is never hashed.
      const motion = hashLatticeCoordinates(motionHash, baseX + column - 1, baseZ + row - 1);
      const rawX = (((motion >>> 16) & 0xffff) * TERRAIN_PLATE_HASH_16BIT_SCALE - 0.5) * 2;
      const rawZ = ((motion & 0xffff) * TERRAIN_PLATE_HASH_16BIT_SCALE - 0.5) * 2;
      const divisor = Math.max(1, Math.hypot(rawX, rawZ));
      scratch.motionX[slot] = rawX / divisor;
      scratch.motionZ[slot] = rawZ / divisor;
      scratch.active[activeCount] = slot;
      activeCount += 1;
    }
  }

  // 3. Every pair of reachable plates contributes its own closing rate,
  //    weighted by both reaches and by across-strike proximity to the pair's
  //    perpendicular bisector (the exact Voronoi edge between them).
  let convergence = 0;
  for (let first = 0; first < activeCount; first += 1) {
    const a = scratch.active[first]!;
    for (let second = first + 1; second < activeCount; second += 1) {
      const b = scratch.active[second]!;
      const spanX = scratch.siteX[b]! - scratch.siteX[a]!;
      const spanZ = scratch.siteZ[b]! - scratch.siteZ[a]!;
      const span = Math.hypot(spanX, spanZ);
      if (span < 1e-6) continue;
      const normalX = spanX / span;
      const normalZ = spanZ / span;
      const closing = (scratch.motionX[a]! - scratch.motionX[b]!) * normalX
        + (scratch.motionZ[a]! - scratch.motionZ[b]!) * normalZ;
      if (closing <= 0) continue;
      const offset = (localX - (scratch.siteX[a]! + scratch.siteX[b]!) * 0.5) * normalX
        + (localZ - (scratch.siteZ[a]! + scratch.siteZ[b]!) * 0.5) * normalZ;
      const belt = 1 - smoothstep(
        0,
        TERRAIN_PLATE_BOUNDARY_WIDTH_CELLS,
        offset < 0 ? -offset : offset,
      );
      if (belt <= 0) continue;
      const contribution = closing * TERRAIN_PLATE_CLOSING_SCALE * belt
        * scratch.weight[a]! * scratch.weight[b]!;
      if (contribution <= 0) continue;
      convergence += contribution;
    }
  }
  return { convergence: saturate(convergence) };
}
