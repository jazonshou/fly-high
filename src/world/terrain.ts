import {
  runwayCrownHeight,
  runwayEarthworksHeightLocal,
  runwayEarthworksProfile,
} from "@/src/render/webgpu/terrain/RunwayEarthworks";
import {
  channelCarveDepth,
  type CarvedChannelSet,
} from "@/src/render/webgpu/terrain/RiverChannels";
import { getAirportInfluence, isPointOnRunway, worldToRunway } from "./airport";
import { sampleGeologicalRelief, sampleTerrainPlates } from "./geology";
import {
  blendTowardExpectation,
  clamp,
  fbm2D,
  filteredValueNoise2D,
  lerp,
  RIDGED_OCTAVE_BAND_LIMIT_MEAN,
  ridgedChannelVarianceKept,
  ridgedFbm2D,
  saturate,
  smoothstep,
  valueNoise2D,
} from "./noise";
import {
  classifyLandCover,
  dominantLandCover,
} from "@/src/render/webgpu/terrain/LandCoverClassifier";
import { SurfaceMaterial } from "@/src/render/webgpu/terrain/surfaceMaterials";
import { mixSeed } from "./seed";
import {
  TERRAIN_BIOME_NAMES,
  TerrainBiome,
  type TerrainCollisionSample,
  type TerrainBiomeId,
  type TerrainColor,
  type TerrainSample,
  type WorldDefinition,
  type WorldVector3,
} from "./types";

/** 3-8's camber, mirrored for the collision normal. The profile owns the value. */
const RUNWAY_CROWN_METERS = runwayEarthworksProfile.crownMeters;

/** Phase 5's shelf/slope/abyssal uplift profile bottoms at the abyssal plain. */
export const MIN_TERRAIN_HEIGHT = -4_500;
/** Activated Phase 5 headroom. The analytic compatibility kernel remains below it. */
export const MAX_TERRAIN_HEIGHT = 4_500;
export const TERRAIN_NORMAL_SAMPLE_DISTANCE = 2;

/**
 * Spatial material fields consumed by the landscape-evolution operators.
 *
 * Fabric is double-angle encoded: `(cos(2θ), sin(2θ))`. A geological
 * direction has no arrow, so θ and θ+π are the same orientation; blending a
 * scalar angle would introduce a discontinuity at that wrap.
 */
export interface TerrainEvolutionGeologySample {
  fabricCos2: number;
  fabricSin2: number;
  /** Dimensionless stream-power K multiplier. */
  erodibility: number;
  /** Local dry angle of repose, in degrees. */
  reposeDegrees: number;
}

function terrainEvolutionFabricDoubleAngle(
  seedHash: number,
  x: number,
  z: number,
  filterWidthMeters: number,
): number {
  // Two very broad fields stand in for the locally blended directions of the
  // seeded plate boundaries. Encoding the result in double-angle space is the
  // load-bearing part of the contract: interpolation never crosses an angle
  // branch cut and every downstream anisotropic field turns with the range.
  const directionX = filteredValueNoise2D(
    mixSeed(seedHash, 154),
    x / 96_000,
    z / 96_000,
    96_000,
    filterWidthMeters,
  );
  const directionZ = filteredValueNoise2D(
    mixSeed(seedHash, 155),
    x / 72_000 + 17.3,
    z / 72_000 - 9.1,
    72_000,
    filterWidthMeters,
  );
  if (Math.hypot(directionX, directionZ) < 1e-8) return 0;
  return Math.atan2(directionZ, directionX);
}

/** Sample the seeded structural fabric and lithology fields used by erosion. */
export function sampleTerrainEvolutionGeology(
  seedHash: number,
  x: number,
  z: number,
  filterWidthMeters: number,
  target: TerrainEvolutionGeologySample = {
    fabricCos2: 1,
    fabricSin2: 0,
    erodibility: 1,
    reposeDegrees: 34,
  },
): TerrainEvolutionGeologySample {
  assertFiniteCoordinate(x, "x");
  assertFiniteCoordinate(z, "z");
  assertFilterWidth(filterWidthMeters);
  const doubleAngle = terrainEvolutionFabricDoubleAngle(
    seedHash,
    x,
    z,
    filterWidthMeters,
  );
  const lithology = filteredValueNoise2D(
    mixSeed(seedHash, 156),
    x / 28_000,
    z / 28_000,
    28_000,
    filterWidthMeters,
  );
  const jointing = filteredValueNoise2D(
    mixSeed(seedHash, 157),
    x / 9_500 + 4.7,
    z / 9_500 - 12.8,
    9_500,
    filterWidthMeters,
  );
  const hardness = saturate(0.5 + lithology * 0.38 + jointing * 0.12);
  target.fabricCos2 = Math.cos(doubleAngle);
  target.fabricSin2 = Math.sin(doubleAngle);
  target.erodibility = lerp(1.45, 0.32, hardness);
  target.reposeDegrees = lerp(28, 42, hardness);
  return target;
}

/**
 * Full-bandwidth expectations of the kernel's nonlinear ridge composites,
 * measured numerically over 250k samples spanning ~2000 lattice cells (2026-08-17). As a
 * channel's texture fades under band-limiting, each composite blends toward
 * its expectation (see blendTowardExpectation) so coarse pages keep the same
 * mean height as fine ones — pow() and threshold smoothsteps otherwise lose
 * several metres of mean uplift per LOD (the amplitudeSum trap's quieter
 * sibling).
 */
// Exported since `4-1`: the WGSL transliteration INJECTS these values from
// this module rather than retyping them. A wrong digit changes coarse-page
// mean height by metres and would pass every parity test run at
// `filterWidth = 0`, because `blendTowardExpectation` short-circuits there.
export const RIDGES_POW_212_MEAN = 0.2125;
export const RIDGES_POW_158_MEAN = 0.299;
export const RIDGES_INVERSE_POW_31_MEAN = 0.2072;
export const RIDGES_SMOOTH_42_82_MEAN = 0.1965;
export const LOCAL_RIDGES_KNOLL_MEAN = 0.1534;

function assertFiniteCoordinate(value: number, label: string): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${label} must be finite`);
  }
}

function assertFilterWidth(filterWidthMeters: number): void {
  if (!Number.isFinite(filterWidthMeters) || filterWidthMeters < 0) {
    throw new RangeError("filterWidthMeters must be finite and non-negative");
  }
}

/**
 * The natural (pre-airport) terrain kernel. It deliberately operates only on
 * global coordinates and a uint32 seed, so workers and collision code can share
 * it without any renderer state.
 *
 * SOLE HEIGHT AUTHORITY (§1.3). Until 5-2, this function is the one producer
 * of terrain shape for both physics (through src/sim/terrainGrid.ts) and
 * rendering (through tile generation), so the surfaces agree by construction.
 * At 5-2 the eroded GPU grid becomes the authority and this kernel survives
 * only as (a) the tectonic uplift input to erosion and (b) the above-500 m-AGL
 * collision fallback. Do not add other height producers.
 *
 * `filterWidthMeters` is the half-width of the sampling footprint. Phase 0
 * threads it as a required positional parameter and ignores it — a behavioural
 * no-op — so that 1B-2's band-limiting is a diff inside two functions instead
 * of a simultaneous signature-and-behaviour change across every call site.
 * Positional and required on purpose: this kernel runs ~181 times per vertex,
 * so an options object would allocate in the hottest loop in the codebase, and
 * a defaulted parameter would let a call site silently reintroduce the horizon
 * crawl. Collision keeps 0 (the full-bandwidth kernel) forever.
 */
export function sampleNaturalTerrainHeight(
  seedHash: number,
  x: number,
  z: number,
  filterWidthMeters: number,
): number {
  assertFiniteCoordinate(x, "x");
  assertFiniteCoordinate(z, "z");
  assertFilterWidth(filterWidthMeters);

  const warpScale = 1 / 18_000;
  const warpX =
    filteredValueNoise2D(mixSeed(seedHash, 101), x * warpScale, z * warpScale, 18_000, filterWidthMeters) * 2_400;
  const warpZ =
    filteredValueNoise2D(mixSeed(seedHash, 102), x * warpScale + 19.4, z * warpScale - 7.7, 18_000, filterWidthMeters) * 2_400;
  const warpedX = x + warpX;
  const warpedZ = z + warpZ;

  const continental =
    fbm2D(mixSeed(seedHash, 110), warpedX / 8_600, warpedZ / 8_600, 4, 2.01, 0.52, 8_600, filterWidthMeters) * 0.5 +
    0.5;
  const land = smoothstep(0.38, 0.57, continental);
  const continentalShelf = lerp(-105, 135, smoothstep(0.2, 0.8, continental));

  const rolling =
    fbm2D(mixSeed(seedHash, 120), warpedX / 1_650, warpedZ / 1_650, 5, 2, 0.48, 1_650, filterWidthMeters);
  const fine = fbm2D(mixSeed(seedHash, 121), x / 310, z / 310, 3, 2.04, 0.46, 310, filterWidthMeters);

  const mountainField =
    fbm2D(mixSeed(seedHash, 130), warpedX / 13_500, warpedZ / 13_500, 3, 2, 0.55, 13_500, filterWidthMeters) * 0.5 +
    0.5;
  // A broad foothill mask precedes the rarer high-alpine mask. The old kernel
  // only emitted meaningful relief when the latter happened to cross a high
  // threshold, which left otherwise valid seeds visually indistinguishable
  // from a flat plane for tens of kilometres around the starter airport.
  const foothillRegion = smoothstep(0.34, 0.7, mountainField);
  const mountainRegion = smoothstep(0.47, 0.76, mountainField);
  const ridges =
    ridgedFbm2D(mixSeed(seedHash, 131), warpedX / 2_550, warpedZ / 2_550, 5, 2_550, filterWidthMeters);
  const localRidges =
    ridgedFbm2D(mixSeed(seedHash, 132), warpedX / 1_050, warpedZ / 1_050, 4, 1_050, filterWidthMeters);
  const ridgesKept = ridgedChannelVarianceKept(5, 2_550, filterWidthMeters);
  const localRidgesKept = ridgedChannelVarianceKept(4, 1_050, filterWidthMeters);
  const foothillHeight = land * foothillRegion
    * blendTowardExpectation(Math.pow(Math.max(0, ridges), 2.12), RIDGES_POW_212_MEAN, ridgesKept)
    * 285;
  const mountainHeight = land * mountainRegion
    * blendTowardExpectation(Math.pow(Math.max(0, ridges), 1.58), RIDGES_POW_158_MEAN, ridgesKept)
    * 1_390;

  // Mid-scale relief stops broad mountain masks from becoming smooth domes.
  // It is strongest around existing uplift, preserving recognizable plains
  // and coastlines while carving shoulders, gullies, and secondary summits.
  const rockyKnolls =
    land *
    (0.34 + foothillRegion * 0.66) *
    blendTowardExpectation(
      Math.pow(Math.max(0, smoothstep(0.3, 0.86, localRidges)), 2.25),
      LOCAL_RIDGES_KNOLL_MEAN,
      localRidgesKept,
    ) *
    (72 + foothillRegion * 115);
  // (localRidges - 0.48) is linear in the channel, hence already unbiased.
  const cragDetail =
    land *
    mountainRegion *
    blendTowardExpectation(smoothstep(0.42, 0.82, ridges), RIDGES_SMOOTH_42_82_MEAN, ridgesKept) *
    (localRidges - 0.48) *
    360;
  const valleyCarve =
    land * foothillRegion
    * blendTowardExpectation(
      Math.pow(Math.max(0, 1 - ridges), 3.1),
      RIDGES_INVERSE_POW_31_MEAN,
      ridgesKept,
    )
    * (55 + mountainRegion * 105);
  const geologicalRelief = sampleGeologicalRelief(
    seedHash,
    warpedX,
    warpedZ,
    filterWidthMeters,
    land,
    foothillRegion,
    mountainRegion,
  );

  // Plains occur naturally where mountainRegion is low; hills become stronger
  // inland while coastlines retain gentler slopes.
  const hillStrength = land * (34 + 96 * (1 - mountainRegion * 0.55));
  const height =
    continentalShelf +
    rolling * hillStrength +
    fine * (5 + land * 12) +
    rockyKnolls +
    foothillHeight +
    mountainHeight +
    cragDetail -
    valleyCarve +
    geologicalRelief;
  return clamp(height, MIN_TERRAIN_HEIGHT, MAX_TERRAIN_HEIGHT);
}

/**
 * Phase 5's pre-erosion tectonic field.
 *
 * This is intentionally separate from `sampleNaturalTerrainHeight`: explicit
 * `worldEvolution: "analytic"` worlds keep the historical pointwise kernel,
 * while eroded worlds feed this uplift/lithology field to the macro and page
 * operators. In particular, the old valley/ravine/talus carve proxies are not
 * present here; drainage and mass movement now create those shapes.
 */
export function sampleTerrainUpliftHeight(
  seedHash: number,
  x: number,
  z: number,
  filterWidthMeters: number,
): number {
  assertFiniteCoordinate(x, "x");
  assertFiniteCoordinate(z, "z");
  assertFilterWidth(filterWidthMeters);

  const warpScale = 1 / 18_000;
  const warpX = filteredValueNoise2D(
    mixSeed(seedHash, 101),
    x * warpScale,
    z * warpScale,
    18_000,
    filterWidthMeters,
  ) * 2_400;
  const warpZ = filteredValueNoise2D(
    mixSeed(seedHash, 102),
    x * warpScale + 19.4,
    z * warpScale - 7.7,
    18_000,
    filterWidthMeters,
  ) * 2_400;
  const warpedX = x + warpX;
  const warpedZ = z + warpZ;

  // Preserve the established coastline field while replacing its uniform
  // -105 m floor with shelf -> continental slope -> abyssal plain.
  const continental = fbm2D(
    mixSeed(seedHash, 110),
    warpedX / 8_600,
    warpedZ / 8_600,
    4,
    2.01,
    0.52,
    8_600,
    filterWidthMeters,
  ) * 0.5 + 0.5;
  const land = smoothstep(0.38, 0.57, continental);
  const abyssToShelf = lerp(-4_000, -140, smoothstep(0.08, 0.36, continental));
  const continentalProfile = lerp(
    abyssToShelf,
    135,
    smoothstep(0.34, 0.58, continental),
  );

  const doubleAngle = terrainEvolutionFabricDoubleAngle(
    seedHash,
    warpedX,
    warpedZ,
    filterWidthMeters,
  );
  const angle = doubleAngle * 0.5;
  const fabricCos = Math.cos(angle);
  const fabricSin = Math.sin(angle);
  const fabricX = warpedX * fabricCos + warpedZ * fabricSin;
  const fabricZ = -warpedX * fabricSin + warpedZ * fabricCos;
  // W-4: convergence is a property of the BOUNDARY the point sits on, not of
  // a seeded noise maximum it happens to sit near. `sampleTerrainPlates`
  // tessellates the world into Lloyd-relaxed plates, gives each its own motion
  // vector, and returns the summed closing rate of the nearby boundaries — so
  // a range raised by a boundary is raised along the boundary's whole length.
  // The two noise channels this replaces (150 ridged boundary, 151 relative
  // motion) are retired; nothing else reads them.
  //
  // MEASURED, NOT ASSUMED: rotating the range channel into the boundary's own
  // across-strike frame (the obvious next step, implemented and measured
  // 2026-08-30) makes assertion 96's local half WORSE — median range
  // anisotropy 2.913 -> 2.050 and the share reaching 2:1 78% -> 50% — because
  // the boundary normal turns from one site pair to the next, so within a
  // 16 km window it is LESS coherent than the 96 km fabric field it replaced.
  // The range channel therefore keeps the seeded fabric frame; the plates
  // supply the amplitude, not the bearing.
  const convergence = sampleTerrainPlates(
    seedHash,
    warpedX,
    warpedZ,
    filterWidthMeters,
  ).convergence;

  // The 12:1 anisotropic range channel is local to the rotating range frame,
  // never a fixed compass bearing.
  const rangeRidges = ridgedFbm2D(
    mixSeed(seedHash, 152),
    fabricX / 6_000,
    fabricZ / 72_000,
    5,
    6_000,
    filterWidthMeters,
  );
  const rangeUplift = land * convergence
    * Math.pow(Math.max(0, rangeRidges), 1.42)
    * (900 + convergence * 2_850);

  // The inherited provinces/rolling/ridge mass remain uplift, as specified by
  // 5-8a. Pointwise faux erosion does not: no inverse-ridge valley term and no
  // ravine or talus subtraction appears in this authority.
  const rolling = fbm2D(
    mixSeed(seedHash, 120),
    warpedX / 1_650,
    warpedZ / 1_650,
    5,
    2,
    0.48,
    1_650,
    filterWidthMeters,
  );
  const province = fbm2D(
    mixSeed(seedHash, 130),
    warpedX / 13_500,
    warpedZ / 13_500,
    3,
    2,
    0.55,
    13_500,
    filterWidthMeters,
  ) * 0.5 + 0.5;
  const foothills = smoothstep(0.34, 0.7, province);
  const inheritedRidges = ridgedFbm2D(
    mixSeed(seedHash, 131),
    fabricX / 2_550,
    fabricZ / 8_900,
    5,
    2_550,
    filterWidthMeters,
  );
  const foothillUplift = land * foothills
    * Math.pow(Math.max(0, inheritedRidges), 2.12)
    * 310;

  // The 310 m detail band is uplift: it is coarse enough that drainage and
  // talus rework it rather than merely inheriting it.
  //
  // W-4: the 24 m and 9 m ridged bands that USED to live here (as
  // `fineLithology`, under a `localRock * lithology` mask) are gone. They are
  // now applied POST-EROSION by `sampleTerrainFineBandRelief` under a
  // soil-depth-and-curvature mask — see that function's docblock for the
  // measurements that forced the move.
  const detail310 = fbm2D(
    mixSeed(seedHash, 121),
    x / 310,
    z / 310,
    3,
    2.04,
    0.46,
    310,
    filterWidthMeters,
  ) * (5 + land * 12);

  const hillStrength = land * (30 + 92 * (1 - convergence * 0.45));
  const height = continentalProfile
    + rolling * hillStrength
    + foothillUplift
    + rangeUplift
    + detail310;
  return clamp(height, MIN_TERRAIN_HEIGHT, MAX_TERRAIN_HEIGHT);
}

/**
 * `W-4` (Phase 6, Gate W, register C-4): the fine ridged bands, as a
 * POST-EROSION relief field rather than an uplift input.
 *
 * WHY THE TERM MOVED, AND WHAT THAT DID NOT FIX. C-4's recorded deviation put
 * the 24 m and 9 m bands into `sampleTerrainUpliftHeight` under a
 * fabric/lithology mask, and W-7's statistics suite attributed two failures to
 * it: assertion 87's 3.289 pits/km² at the 50 m footprint (target < 0.1) and
 * assertion 98's INVERTED 0.608:1 valley:crest curvature (target >= 3:1). The
 * argument was that the bands survive on crests, which erosion cannot plane,
 * and are removed from valley floors, which it can.
 *
 * That attribution is measured FALSE (2026-08-30, the same suite):
 *
 *   variant                              87 fine     98 by flow
 *   shipped (bands on the uplift)        3.289/km²   0.608:1
 *   bands deleted, nothing added         2.961/km²   0.605:1
 *   bands post-erosion, this mask, 1x    2.961/km²   0.581:1
 *   ... 2x                               2.961/km²   0.534:1
 *   ... 4x                               2.961/km²   0.461:1
 *
 * A 24 m band box-averaged over a 50 m cell has almost nothing left to make a
 * hollow with, and at a 20 m curvature arm it is a small perturbation on top
 * of the 74-310 m detail that dominates crest roughness. Both real mechanisms
 * are recorded in tests/world.evolution-stats.test.ts: assertion 87's residual
 * is 4-20 cm sills between the 32 m breach reach and the 512 m macro flood,
 * and assertion 98's is a page contributing-area field whose 1st percentile is
 * 2.9e5 m², i.e. no hillslope domain at all.
 *
 * The move is kept because it is right independently of those two numbers: a
 * band applied to the uplift is masked by the tectonic input's lithology,
 * while a band applied after erosion is masked by the surface that actually
 * exists — thin soil on a convex crest exposes structure, a deep-soil
 * convergent hollow buries it, which is §12.1's landscape model and not a
 * proxy for it. It also removes the term from the collision-relevant seed
 * field, where erosion could not touch it.
 *
 * FRAME. The band rides the seeded structural fabric exactly as before, but
 * rotates the UNWARPED world coordinate rather than the domain-warped one. The
 * warp is a ±2.4 km displacement applied to a 96 km/72 km direction field, so
 * the grain it selects is the same one either way; dropping it removes two
 * lattice evaluations from a term that is now evaluated per erosion-scratch
 * texel (384² per page) instead of once inside the uplift sampler.
 * `sampleTerrainEvolutionGeology` already reads the direction field in the
 * world frame for the same reason.
 *
 * Amplitudes are the uplift term's verbatim 2.8 / 1.15 metre weights; the
 * `localRock * (0.7 + lithology * 0.25)` envelope they used to carry is
 * REPLACED (not multiplied) by the post-erosion mask, which is the whole point
 * of the move. Mean-removed per band, so the field adds no bias.
 */
export const TERRAIN_FINE_BAND_24M_AMPLITUDE_METERS = 2.8;
export const TERRAIN_FINE_BAND_9M_AMPLITUDE_METERS = 1.15;

export function sampleTerrainFineBandRelief(
  seedHash: number,
  x: number,
  z: number,
  filterWidthMeters: number,
): number {
  assertFiniteCoordinate(x, "x");
  assertFiniteCoordinate(z, "z");
  assertFilterWidth(filterWidthMeters);
  const angle = terrainEvolutionFabricDoubleAngle(
    seedHash,
    x,
    z,
    filterWidthMeters,
  ) * 0.5;
  const fabricCos = Math.cos(angle);
  const fabricSin = Math.sin(angle);
  const fabricX = x * fabricCos + z * fabricSin;
  const fabricZ = -x * fabricSin + z * fabricCos;
  const ridges24 = ridgedFbm2D(
    mixSeed(seedHash, 158),
    fabricX / 24,
    fabricZ / 96,
    2,
    24,
    filterWidthMeters,
  ) - RIDGED_OCTAVE_BAND_LIMIT_MEAN;
  const ridges9 = ridgedFbm2D(
    mixSeed(seedHash, 159),
    fabricX / 9,
    fabricZ / 36,
    1,
    9,
    filterWidthMeters,
  ) - RIDGED_OCTAVE_BAND_LIMIT_MEAN;
  return ridges24 * TERRAIN_FINE_BAND_24M_AMPLITUDE_METERS
    + ridges9 * TERRAIN_FINE_BAND_9M_AMPLITUDE_METERS;
}

/**
 * 3-8: the airport's earthworks, applied to a natural height. One profile,
 * evaluated identically by the render path and by physics — the §1.3
 * same-authority contract, one derivative deeper than Phase 0 needed it.
 */
function applyAirportEarthworks(
  world: WorldDefinition,
  naturalHeight: number,
  x: number,
  z: number,
): number {
  const airport = world.airport;
  if (!airport) return naturalHeight;
  const local = worldToRunway(airport, x, z);
  return runwayEarthworksHeightLocal(
    airport,
    naturalHeight,
    local.along,
    local.across,
    x,
    z,
    world.seedHash,
  );
}

/** Eroded-world source field with the same authored airport earthworks. */
export function sampleFilteredTerrainUpliftHeight(
  world: WorldDefinition,
  x: number,
  z: number,
  filterWidthMeters: number,
): number {
  const upliftHeight = sampleTerrainUpliftHeight(
    world.seedHash,
    x,
    z,
    filterWidthMeters,
  );
  return applyAirportEarthworks(world, upliftHeight, x, z);
}

/** Fast collision-query path: only computes terrain elevation. */
export function sampleTerrainHeight(world: WorldDefinition, x: number, z: number): number {
  // Physics and collision always sample the full-bandwidth kernel (width 0).
  const naturalHeight = sampleNaturalTerrainHeight(world.seedHash, x, z, 0);
  return applyAirportEarthworks(world, naturalHeight, x, z);
}

/**
 * `5-12a`: height with river channels carved in — the only carved authority.
 *
 * **Ordering is carried by this signature, not by a rule.** A `CarvedChannelSet`
 * has one constructor and it takes a finished `HydrologyGenerationResult`, so a
 * caller holding one has necessarily already traced. `sampleTerrainHeight`
 * stays uncarved and is what hydrology samples, which holds the other half of
 * the cycle open.
 *
 * **This must stay `uncarved - channelCarveDepth` with no other term.** The GPU
 * height kernel mirrors exactly this expression; anything read here that the
 * kernel cannot read puts collision and render on different terrain, which is
 * `3-8` — 15.3 m apart on the runway, the feature this copies.
 *
 * ---
 *
 * **NOTHING CALLS THESE YET, AND FOUR REQUIREMENTS BIND WHOEVER FIRST DOES.**
 * They are recorded here rather than in a plan document because a plan is not
 * in the diff when someone wires this up.
 *
 * 1. **Physics does not reach this function inside the airport platform.**
 *    There are FOUR airport short-circuits over two regions, and every one of
 *    them returns before `sampleTerrainHeight`:
 *      `getAirportInfluence(...) >= 1` — terrain.ts (sampleTerrainCollisionHeight),
 *                                        sim/terrainGrid.ts (sampleGroundHeight)
 *      `isPointOnRunway(...)`         — terrain.ts (sampleTerrainCollision),
 *                                        sim/terrainGrid.ts (sampleGroundContact)
 *    So a channel crossing the platform renders as a trench that collision has
 *    never heard of. That is `3-8` with the sign flipped, and `airportSite.ts`
 *    has no knowledge of hydrology, so nothing keeps a channel off the apron.
 *
 * 2. **CPU/GPU agreement holds at L0 ONLY, and a test must SAY it is L0-only.**
 *    `terrainPageFilterWidthMeters(0) === 0` and `terrainSupersampleOffsets(0)`
 *    is the single offset `[0,0]`, so L0 is bit-identical by construction. At
 *    L1+ `samplePageTexel` AVERAGES `count` offset evaluations of
 *    `pageHeightAt`, while this function subtracts a single centre-point
 *    `channelCarveDepth`. A GPU carve placed inside `pageHeightAt` therefore
 *    computes `mean(carve(p_i))` against this `carve(centre)`. They differ
 *    wherever the carve is non-linear across a texel — which for a trapezoid
 *    is exactly the rim, the only place anyone looks.
 *
 * 3. **The prop-placement samplers travel with this one, or are named as
 *    knowingly uncarved.** The visible ground is GPU-displaced, so these are
 *    not a third opinion about height — they are a third set of things
 *    STANDING on it: the ground-cover height tile, hangars, tower, fence, fuel
 *    farm, signage, the lake plate whose mesh edge IS the waterline, and the
 *    free-fly camera clamp. Every one hangs over a riverbed otherwise.
 *
 * 4. **A per-page cull expansion is DERIVED, never chosen.** Rivers are
 *    globally anchored — the source lattice is in absolute world coordinates
 *    and page bounds only select cells, never change identity or jitter — so
 *    the only page-dependence is `cropRiverToBounds` truncating at the rim.
 *    That makes the margin arithmetic: maximum channel half-width plus maximum
 *    trace segment length. Probe the seam where a channel crosses a page
 *    boundary; a uniform grid misses precisely the case that breaks.
 */
export function sampleCarvedTerrainHeight(
  world: WorldDefinition,
  channels: CarvedChannelSet,
  x: number,
  z: number,
): number {
  return sampleTerrainHeight(world, x, z) - channelCarveDepth(channels, x, z);
}

/** Band-limited render-path height with channels carved in. See above. */
export function sampleCarvedFilteredTerrainHeight(
  world: WorldDefinition,
  channels: CarvedChannelSet,
  x: number,
  z: number,
  filterWidthMeters: number,
): number {
  return sampleFilteredTerrainHeight(world, x, z, filterWidthMeters)
    - channelCarveDepth(channels, x, z);
}

/**
 * Render-path height with band-limiting (1B-2): the tile generator passes
 * its grid spacing so a coarse mesh is a blurred version of the fine one,
 * not a re-rolled point-sampling of sub-Nyquist octaves. Physics and
 * collision never call this — they keep the width-0 kernel forever.
 */
export function sampleFilteredTerrainHeight(
  world: WorldDefinition,
  x: number,
  z: number,
  filterWidthMeters: number,
): number {
  const naturalHeight = sampleNaturalTerrainHeight(world.seedHash, x, z, filterWidthMeters);
  return applyAirportEarthworks(world, naturalHeight, x, z);
}

/**
 * Height-only physics path with a zero-noise fast path on the airport platform.
 *
 * 3-8: the short-circuit returns `elevation + crown`, not the bare elevation.
 * The fast path stays fast — still one analytic evaluation with no noise and
 * no terrain sampling — but it is no longer a lie: a runway is cambered so
 * water sheds, and without this the aircraft would land on a plane up to
 * 0.35 m away from the surface on screen, worst at the edges where a
 * crosswind landing puts you. Assertion 63 pins the two to within 1 mm.
 */
export function sampleTerrainCollisionHeight(
  world: WorldDefinition,
  x: number,
  z: number,
): number {
  if (
    world.airport &&
    getAirportInfluence(world.airport, x, z) >= 1
  ) {
    return world.airport.elevation
      + runwayCrownHeight(world.airport, worldToRunway(world.airport, x, z).across);
  }
  return sampleTerrainHeight(world, x, z);
}

/**
 * COLLISION ONLY (1B-1). The 2 m central difference is the right footprint
 * for wheels and the crash solver, and the wrong one for every render LOD:
 * uploaded at 128 m spacing it produced 24–35° mean shading error with 3.4%
 * of normals pointing into the surface. Render normals come from the tile's
 * own grid in src/world/tile.ts — do not reintroduce this into any render
 * path. It reaches physics through src/sim/terrainGrid.ts.
 */
export function sampleTerrainNormal(
  world: WorldDefinition,
  x: number,
  z: number,
  target: WorldVector3 = { x: 0, y: 1, z: 0 },
): WorldVector3 {
  const delta = TERRAIN_NORMAL_SAMPLE_DISTANCE;
  const left = sampleTerrainHeight(world, x - delta, z);
  const right = sampleTerrainHeight(world, x + delta, z);
  const back = sampleTerrainHeight(world, x, z - delta);
  const front = sampleTerrainHeight(world, x, z + delta);
  const gradientX = (right - left) / (2 * delta);
  const gradientZ = (front - back) / (2 * delta);
  const inverseLength = 1 / Math.hypot(gradientX, 1, gradientZ);
  target.x = -gradientX * inverseLength;
  target.y = inverseLength;
  target.z = -gradientZ * inverseLength;
  return target;
}

function createTerrainCollisionTarget(): TerrainCollisionSample {
  return {
    height: 0,
    normal: { x: 0, y: 1, z: 0 },
    isRunway: false,
    friction: 0.86,
  };
}

/**
 * Collision-only terrain sample. It preserves the full sampler's elevation,
 * normal, runway classification, and physics friction semantics without
 * evaluating moisture, temperature, biome noise, airport tint, or color.
 */
export function sampleTerrainCollision(
  world: WorldDefinition,
  x: number,
  z: number,
  target: TerrainCollisionSample = createTerrainCollisionTarget(),
): TerrainCollisionSample {
  const runway = world.airport ? isPointOnRunway(world.airport, x, z) : false;
  if (runway && world.airport) {
    // 3-8: the same crowned surface the renderer draws and
    // sampleTerrainCollisionHeight returns. The normal follows the camber
    // too — a flat normal on a cambered surface is the same lie one
    // derivative up, and the cross-slope is ~1.3 deg at the edge, which is
    // what a real runway has.
    const local = worldToRunway(world.airport, x, z);
    const halfWidth = world.airport.runwayWidth * 0.5 + world.airport.shoulderWidth;
    target.height = world.airport.elevation + runwayCrownHeight(world.airport, local.across);
    const crossGrade = halfWidth > 0
      ? (-2 * RUNWAY_CROWN_METERS * clamp(local.across, -halfWidth, halfWidth))
        / (halfWidth * halfWidth)
      : 0;
    // The gradient is along the runway's ACROSS axis; rotate it back to world.
    const sinHeading = Math.sin(world.airport.headingRadians);
    const cosHeading = Math.cos(world.airport.headingRadians);
    const inverseLength = 1 / Math.hypot(crossGrade, 1);
    target.normal.x = -crossGrade * cosHeading * inverseLength;
    target.normal.y = inverseLength;
    target.normal.z = crossGrade * sinHeading * inverseLength;
    target.isRunway = true;
    target.friction = 1.18;
    return target;
  }
  const height = sampleTerrainHeight(world, x, z);
  sampleTerrainNormal(world, x, z, target.normal);
  target.height = height;
  target.isRunway = runway;
  target.friction = runway ? 1.18 : height <= world.seaLevel ? 0.05 : 0.86;
  return target;
}

export function sampleTerrainMoisture(
  world: WorldDefinition,
  x: number,
  z: number,
  filterWidthMeters: number,
): number {
  assertFilterWidth(filterWidthMeters);
  // 4-6 (D5): `filterWidthMeters` was validated here and then never used —
  // the one remaining point-sampled field in the height/appearance chain. It
  // is band-limited now for the same reason height is (1B-2): sampled onto a
  // coarse page, an unfiltered 850 m channel re-rolls its phase per level and
  // the land cover changes when a page changes LOD. Width 0 is bit-identical.
  const broad = fbm2D(
    mixSeed(world.seedHash, 201), x / 5_200, z / 5_200, 4, 2, 0.52,
    5_200, filterWidthMeters,
  );
  const local = filteredValueNoise2D(
    mixSeed(world.seedHash, 202), x / 850, z / 850, 850, filterWidthMeters,
  );
  // Elongated rain-shadow provinces break the old near-uniform moisture field
  // into wet watersheds, dry uplands, and transitional ecological corridors.
  // The SMALLER period keys the fade, as every anisotropic channel does.
  let rainShadowX: number;
  let rainShadowZ: number;
  if (world.worldEvolution === "eroded") {
    const evolutionFabricAngle = terrainEvolutionFabricDoubleAngle(
      world.seedHash,
      x,
      z,
      filterWidthMeters,
    ) * 0.5;
    const fabricCos = Math.cos(evolutionFabricAngle);
    const fabricSin = Math.sin(evolutionFabricAngle);
    rainShadowX = x * fabricCos + z * fabricSin;
    rainShadowZ = -x * fabricSin + z * fabricCos;
  } else {
    // Explicit analytic parity keeps the historical 0.42 shear bit-for-bit.
    rainShadowX = x + z * 0.42;
    rainShadowZ = z - x * 0.42;
  }
  const rainShadow = filteredValueNoise2D(
    mixSeed(world.seedHash, 203),
    rainShadowX / 18_000,
    rainShadowZ / 9_500,
    9_500,
    filterWidthMeters,
  );
  return saturate(0.5 + broad * 0.37 + local * 0.13 + rainShadow * 0.17);
}

/** The smooth 11 km climate field feeding temperature; interpolable at tile scale. */
export function sampleTerrainClimate(
  world: WorldDefinition,
  x: number,
  z: number,
  filterWidthMeters = 0,
): number {
  return fbm2D(
    mixSeed(world.seedHash, 211), x / 11_000, z / 11_000, 3, 2, 0.5,
    11_000, filterWidthMeters,
  );
}

/**
 * R-13 — the seasonal kernel term. Every constant below was tuned against
 * the midsummer default clock (dayOfYear 171, the "one pleasant flying day"
 * all three presets share), so the seasonal functions are ANCHORED there:
 * at the reference day they are exact zeros/ones and the shipped world is
 * bit-identical. Winter is expressed as a deviation from that tuned state.
 *
 * Class K: pure trigonometry over numbers, transliterable to WGSL under the
 * 0-4 portability rules.
 */
export const TERRAIN_REFERENCE_DAY_OF_YEAR = 171;

/**
 * Reference-day snowline altitude above sea level, metres — the anchor the
 * seasonal descent (R-13) lowers. Exported for 2-13a: canopy snow uses the
 * same snowline the ground blanket does, per the seasonalSnowCover rule.
 */
export const TERRAIN_REFERENCE_SNOWLINE_OFFSET_METERS = 1_520;

/** Warmest day of the year (thermal lag ~1 month past the solstice). */
const HOTTEST_DAY_OF_YEAR = 199;
/** Peak-to-trough annual temperature swing at the poles, Kelvin. */
const ANNUAL_TEMPERATURE_RANGE_POLAR_K = 14;
/**
 * Kelvin per unit of the normalised temperature field: the elevation-cooling
 * slope is 1/2450 per metre, and a 6.5 K/km standard lapse makes one
 * normalised unit 2450 m × 6.5 K/km = 15.925 K.
 */
const KELVIN_PER_NORMALIZED_TEMPERATURE = 15.925;
/** Metres of iso-temperature (snowline) shift per normalised temperature unit. */
const METERS_PER_NORMALIZED_TEMPERATURE = 2_450;

/**
 * Seasonal air-temperature offset from the ANNUAL MEAN, in Kelvin. Positive
 * in the hemisphere's summer. `4-6`'s land-cover classifier and `2-13a`'s
 * appearance field consume this same term rather than reinventing winter.
 */
export function seasonalTemperatureOffsetK(
  dayOfYear: number,
  latitudeDegrees: number,
): number {
  const latitudeRadians = (latitudeDegrees * Math.PI) / 180;
  const annualRangeK = ANNUAL_TEMPERATURE_RANGE_POLAR_K * Math.abs(Math.sin(latitudeRadians));
  const hottest = latitudeDegrees >= 0
    ? HOTTEST_DAY_OF_YEAR
    : HOTTEST_DAY_OF_YEAR - 365 / 2;
  return (annualRangeK / 2) * Math.cos((2 * Math.PI * (dayOfYear - hottest)) / 365);
}

/**
 * The seasonal temperature delta from the reference (midsummer-tuned) state,
 * in normalised temperature units. Exactly 0 at the reference day; ≤ ~0 the
 * rest of the year in the northern hemisphere.
 */
export function seasonalTemperatureShift(
  dayOfYear: number,
  latitudeDegrees: number,
): number {
  return (
    (seasonalTemperatureOffsetK(dayOfYear, latitudeDegrees)
      - seasonalTemperatureOffsetK(TERRAIN_REFERENCE_DAY_OF_YEAR, latitudeDegrees))
    / KELVIN_PER_NORMALIZED_TEMPERATURE
  );
}

/**
 * How far the visible snowline has DESCENDED below its reference-day
 * altitude, metres. 0 at the reference day.
 */
export function seasonalSnowlineDescentMeters(
  dayOfYear: number,
  latitudeDegrees: number,
): number {
  return Math.max(
    0,
    -seasonalTemperatureShift(dayOfYear, latitudeDegrees) * METERS_PER_NORMALIZED_TEMPERATURE,
  );
}

/** 0 at the reference midsummer day, approaching 1 at the depth of winter. */
export function seasonalWinterFraction(
  dayOfYear: number,
  latitudeDegrees: number,
): number {
  const latitudeRadians = (latitudeDegrees * Math.PI) / 180;
  const annualRangeK = ANNUAL_TEMPERATURE_RANGE_POLAR_K * Math.abs(Math.sin(latitudeRadians));
  if (annualRangeK <= 0) return 0;
  const deltaK =
    seasonalTemperatureOffsetK(TERRAIN_REFERENCE_DAY_OF_YEAR, latitudeDegrees)
    - seasonalTemperatureOffsetK(dayOfYear, latitudeDegrees);
  return saturate(deltaK / annualRangeK);
}

/**
 * Seasonal humidity multiplier for the aerial perspective's turbidity
 * (deviation D-5 shipped `mieTurbidityMultiplier = 1 + humidity·26`, so this
 * moves the haze with no new plumbing). Winter air is clearer: 1.0 at the
 * reference day, ~0.62 at the depth of a 45°N winter.
 */
export function seasonalHumidityMultiplier(
  dayOfYear: number,
  latitudeDegrees: number,
): number {
  return 1 - 0.4 * seasonalWinterFraction(dayOfYear, latitudeDegrees);
}

/** Temperature from a precomputed climate value plus exact per-point cooling. */
export function terrainTemperatureFromClimate(
  world: WorldDefinition,
  climate: number,
  height: number,
): number {
  const elevationCooling = Math.max(0, height - world.seaLevel) / 2_450;
  return saturate(0.66 + climate * 0.2 - elevationCooling);
}

export function sampleTerrainTemperature(
  world: WorldDefinition,
  x: number,
  z: number,
  filterWidthMeters: number,
  height = sampleTerrainHeight(world, x, z),
): number {
  assertFilterWidth(filterWidthMeters);
  return terrainTemperatureFromClimate(world, sampleTerrainClimate(world, x, z), height);
}

/**
 * `4-6`/`R-27`: the biome id is now the classifier's DOMINANT material, not a
 * threshold cascade.
 *
 * `classifyBiome`'s cascade is deleted. It answered one question with one
 * hard-edged id, which is why material identity at a boundary could only ever
 * be a coin flip between two neighbours; `classifyLandCover` returns a weight
 * vector with no boundary in it at all. This function exists only to keep the
 * `TerrainBiome` id — which vegetation, wildlife and the HUD still name — as a
 * derived READING of that vector rather than a second opinion about it.
 */
function classifyBiome(
  world: WorldDefinition,
  height: number,
  slope: number,
  moisture: number,
  temperature: number,
  runway: boolean,
  airportInfluence: number,
): TerrainBiomeId {
  if (runway) return TerrainBiome.RUNWAY;
  if (height <= world.seaLevel) return TerrainBiome.WATER;
  // **The ECOLOGICAL classification, which is deliberately season-invariant.**
  //
  // The classifier's `dayOfYear` drives the snow weight, and snow is PAINT.
  // Letting it move the dominant material would flip forest to snow with the
  // calendar and delete every forest each winter — which `2-18` forbids in as
  // many words: species mix stays climatic, only the paint migrates. So the
  // biome id is read at the reference day, and the splat bake passes the real
  // one. Same authority, two readings, and the difference is stated rather
  // than emergent.
  const weights = classifyLandCover({
    elevationMeters: height - world.seaLevel,
    slope,
    moisture,
    temperature,
    aspect: 0,
    airportInfluence,
    dayOfYear: TERRAIN_REFERENCE_DAY_OF_YEAR,
    seasonalTemperatureShift: 0,
  });
  return BIOME_FOR_DOMINANT_MATERIAL[dominantLandCover(weights)] ?? TerrainBiome.GRASSLAND;
}

/**
 * The one mapping from a dominant material back to the legacy biome id.
 *
 * Deliberately a lookup rather than a cascade: every entry is the biome whose
 * `SURFACE_MATERIALS_BY_BIOME` primary IS that material, so the round trip
 * `biome -> primary material -> biome` is the identity and the two tables
 * cannot drift.
 */
const BIOME_FOR_DOMINANT_MATERIAL: Readonly<Record<number, TerrainBiomeId>> = Object.freeze({
  [SurfaceMaterial.Sand]: TerrainBiome.BEACH,
  [SurfaceMaterial.Grass]: TerrainBiome.GRASSLAND,
  [SurfaceMaterial.ForestFloor]: TerrainBiome.FOREST,
  [SurfaceMaterial.Shrub]: TerrainBiome.HIGHLAND,
  [SurfaceMaterial.Rock]: TerrainBiome.ALPINE,
  [SurfaceMaterial.Snow]: TerrainBiome.SNOW,
  [SurfaceMaterial.DryGrass]: TerrainBiome.GRASSLAND,
  [SurfaceMaterial.Gravel]: TerrainBiome.ALPINE,
  [SurfaceMaterial.Asphalt]: TerrainBiome.RUNWAY,
  [SurfaceMaterial.Concrete]: TerrainBiome.RUNWAY,
});

const PALETTES: Readonly<Record<TerrainBiomeId, readonly [number, number, number]>> = {
  [TerrainBiome.WATER]: [0.08, 0.19, 0.25],
  [TerrainBiome.BEACH]: [0.68, 0.605, 0.425],
  [TerrainBiome.GRASSLAND]: [0.29, 0.445, 0.215],
  [TerrainBiome.FOREST]: [0.115, 0.275, 0.15],
  [TerrainBiome.HIGHLAND]: [0.335, 0.345, 0.255],
  [TerrainBiome.ALPINE]: [0.405, 0.405, 0.385],
  [TerrainBiome.SNOW]: [0.825, 0.855, 0.865],
  [TerrainBiome.RUNWAY]: [0.16, 0.18, 0.19],
};

/**
 * R-13: the seasonal snow BLANKET — an appearance overlay, deliberately not
 * a classification change. Threading the seasonal offset into
 * `classifyBiome`/`sampleTerrainTemperature` would flip FOREST↔GRASSLAND
 * (and delete forests under winter SNOW) with the calendar, which
 * PHASE_2_EXECUTION_PLAN.md `2-18` explicitly forbids: species mix stays
 * climatic. Ecology reads the climatic fields; only the paint migrates.
 * Exactly 0 at the reference day, so the tuned midsummer world is untouched.
 */
function seasonalSnowCover(
  world: WorldDefinition,
  height: number,
  slope: number,
  temperature: number,
  dayOfYear: number,
): number {
  const shift = seasonalTemperatureShift(dayOfYear, world.latitudeDegrees);
  if (shift >= 0) return 0;
  const snowline =
    world.seaLevel + TERRAIN_REFERENCE_SNOWLINE_OFFSET_METERS
    + shift * METERS_PER_NORMALIZED_TEMPERATURE;
  const heightBand = saturate((height - (snowline - 80)) / 120);
  const coverFromHeight = heightBand * heightBand * (3 - 2 * heightBand);
  const temperatureBand = saturate((0.2 - (temperature + shift)) / 0.06);
  const coverFromCold = temperatureBand * temperatureBand * (3 - 2 * temperatureBand);
  // Steep faces shed snow — the 2-18 slope-weighting rule, applied to the
  // ground the same way it will be applied to canopy and rock.
  const slopeShedding = 1 - saturate((slope - 0.55) * 2.2);
  return Math.max(coverFromHeight, coverFromCold) * slopeShedding;
}

function writeTerrainColor(
  world: WorldDefinition,
  x: number,
  z: number,
  biome: TerrainBiomeId,
  moisture: number,
  slope: number,
  height: number,
  temperature: number,
  dayOfYear: number,
  target: TerrainColor,
): TerrainColor {
  const palette = PALETTES[biome];
  const fineVariation = valueNoise2D(mixSeed(world.seedHash, 230), x / 76, z / 76);
  const broadVariation = valueNoise2D(mixSeed(world.seedHash, 231), x / 680, z / 680);
  const variation =
    fineVariation * 0.035 +
    broadVariation * 0.035 +
    (moisture - 0.5) * (biome === TerrainBiome.GRASSLAND ? -0.06 : -0.025) -
    slope * 0.06;
  const rockBiome = biome === TerrainBiome.HIGHLAND || biome === TerrainBiome.ALPINE;
  // Mineral variation is world-horizontal noise rather than a function of
  // elevation.  Equal-height sine strata produced visible contour/scan lines
  // over medium-distance hills.
  const rockMottle = rockBiome
    ? valueNoise2D(
      mixSeed(world.seedHash, 232),
      x / 118 + broadVariation * 1.7,
      z / 154 - broadVariation * 1.3,
    ) * slope * 0.05
    : 0;
  const warmVariation = broadVariation * (rockBiome ? 0.026 : 0.012);
  target.r = saturate(palette[0] + variation + rockMottle + warmVariation);
  target.g = saturate(palette[1] + variation + rockMottle * 0.64);
  target.b = saturate(palette[2] + variation - rockMottle * 0.18 - warmVariation);
  if (
    biome !== TerrainBiome.WATER
    && biome !== TerrainBiome.RUNWAY
    && biome !== TerrainBiome.SNOW
  ) {
    const cover = seasonalSnowCover(world, height, slope, temperature, dayOfYear);
    if (cover > 0) {
      const snow = PALETTES[TerrainBiome.SNOW];
      // Keep a whisper of the ground variation so the blanket reads as a
      // surface rather than a flat fill.
      const snowR = saturate(snow[0] + variation * 0.3);
      const snowG = saturate(snow[1] + variation * 0.3);
      const snowB = saturate(snow[2] + variation * 0.3);
      target.r += (snowR - target.r) * cover;
      target.g += (snowG - target.g) * cover;
      target.b += (snowB - target.b) * cover;
    }
  }
  return target;
}

function createTerrainSampleTarget(): TerrainSample {
  return {
    height: 0,
    normal: { x: 0, y: 1, z: 0 },
    slope: 0,
    moisture: 0,
    temperature: 0,
    biome: TerrainBiome.GRASSLAND,
    biomeName: "grassland",
    color: { r: 0, g: 0, b: 0 },
    airportInfluence: 0,
    isRunway: false,
  };
}

/**
 * Classification and appearance for a point whose height and slope are
 * already known (1B-1). The tile path computes slope from its own grid
 * normal — at the tile's spacing — and must classify from that same slope,
 * or rock and scree colour at 40 km is assigned by 4 m microslope. Fills
 * everything on the target except `normal`.
 *
 * `moisture` and `temperature` may be supplied precomputed: their finest
 * wavelength is 850 m, so the tile generator samples them on a coarse
 * subgrid and interpolates instead of paying nine noise evaluations per
 * 8 m vertex.
 */
export function sampleTerrainSurface(
  world: WorldDefinition,
  x: number,
  z: number,
  height: number,
  slope: number,
  target: TerrainSample,
  dayOfYear: number = TERRAIN_REFERENCE_DAY_OF_YEAR,
  moisture = sampleTerrainMoisture(world, x, z, 0),
  temperature = sampleTerrainTemperature(world, x, z, 0, height),
): TerrainSample {
  const runway = world.airport ? isPointOnRunway(world.airport, x, z) : false;
  const airportInfluence = world.airport ? getAirportInfluence(world.airport, x, z) : 0;
  const biome = classifyBiome(
    world, height, slope, moisture, temperature, runway, airportInfluence,
  );

  target.height = height;
  target.slope = slope;
  target.moisture = moisture;
  target.temperature = temperature;
  target.biome = biome;
  target.biomeName = TERRAIN_BIOME_NAMES[biome];
  target.airportInfluence = airportInfluence;
  target.isRunway = runway;
  writeTerrainColor(
    world, x, z, biome, moisture, slope, height, temperature, dayOfYear, target.color,
  );
  return target;
}

/** Full visual/climate sample. Supply a reusable target to avoid allocations. */
export function sampleTerrain(
  world: WorldDefinition,
  x: number,
  z: number,
  target: TerrainSample = createTerrainSampleTarget(),
  dayOfYear: number = TERRAIN_REFERENCE_DAY_OF_YEAR,
): TerrainSample {
  const height = sampleTerrainHeight(world, x, z);
  sampleTerrainNormal(world, x, z, target.normal);
  const slope = saturate(1 - target.normal.y);
  return sampleTerrainSurface(world, x, z, height, slope, target, dayOfYear);
}
