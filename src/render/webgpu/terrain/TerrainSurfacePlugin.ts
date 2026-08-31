import { MaterialPluginBase } from "@babylonjs/core/Materials/materialPluginBase";
import type { MaterialDefines } from "@babylonjs/core/Materials/materialDefines";
import type { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { Constants } from "@babylonjs/core/Engines/constants";
import { RawTexture2DArray } from "@babylonjs/core/Materials/Textures/rawTexture2DArray";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import type { Scene } from "@babylonjs/core/scene";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import {
  TERRAIN_CORNER_MORPH_BITS,
  TERRAIN_CORNER_MORPH_LEVELS,
  TERRAIN_CORNER_MORPH_PACKED_MAX,
  TERRAIN_NODE_GRID_RESOLUTION,
} from "./TerrainSpineContract";
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";
import type { UniformBuffer } from "@babylonjs/core/Materials/uniformBuffer";
import type { TerrainTriplanarMode } from "@/src/render/webgpu/core/QualityProfile";
import type { AirportDefinition } from "@/src/world/types";
import {
  seasonalSnowlineDescentMeters,
  seasonalWinterFraction,
  TERRAIN_REFERENCE_DAY_OF_YEAR,
  TERRAIN_REFERENCE_SNOWLINE_OFFSET_METERS,
} from "@/src/world";
import {
  resolveRunwaySurfaceBinding,
  RUNWAY_SURFACE_UNIFORMS,
  RUNWAY_SURFACE_WGSL,
} from "./RunwaySurface";
import {
  landCoverShare,
  meanSurfaceAlbedo,
  SURFACE_MATERIAL_COUNT,
  SURFACE_MATERIALS,
  SurfaceMaterial,
  type SurfaceMaterialSpec,
} from "./surfaceMaterials";
import { TERRAIN_PAGE_HYDROLOGY_ENCODING } from "./TerrainEvolutionContract";
import { HORIZON_FIELD_LOOKUP_WGSL } from "./HorizonField";
// 6-6: the riparian corridor's shape is vegetation-owned. Terrain reaches it
// through the one sanctioned entry point rather than restating four distances.
import {
  CANOPY_DOMINANT_HEIGHT_METERS,
  CANOPY_SURFACE_ALBEDO,
  CANOPY_SURFACE_AMBIENT,
  CANOPY_SURFACE_ROUGHNESS,
  CANOPY_SURFACE_SPECULAR,
  CANOPY_UNDER_SHADE_STRENGTH,
  RIPARIAN_BANK_FADE_END_METERS,
  RIPARIAN_BANK_FADE_START_METERS,
  RIPARIAN_BANK_FULL_METERS,
  RIPARIAN_BANK_NEAR_METERS,
} from "../detail/densityField";
// 6-8: the canopy/terrain handoff is vegetation's law too — the same entry
// point's WGSL half, composed rather than restated.
import { VEGETATION_CANOPY_HANDOFF_WGSL } from "../detail/densityFieldWgsl";
// 6-5: the run-up half of the wetness field is 6-2's, composed rather than
// restated. `WATER_SHORE_RUNUP_WGSL` was written self-contained (no uniform,
// texture, derivative or external helper — pinned by a call-graph scan and a
// standalone GPU compile) precisely so it could land in this shader, which has
// never heard of the water lattice. The TypeScript twins below are the same
// laws' CPU oracle; terrain re-derives none of them.
import {
  WATER_RUNUP_BEACH_SLOPE_MAXIMUM,
  WATER_RUNUP_BEACH_SLOPE_MINIMUM,
  WATER_RUNUP_EXCEEDANCE,
  WATER_SHORE_RUNUP_WGSL,
  waterRunupClock,
  waterShoreRunupHeight,
  waterShoreRunupPhase,
  waterShoreWetness,
  type WaterShoreSwell,
} from "../water/WaterShaders";

/**
 * 3-2 — the terrain surface plugin (owner: terrain-material).
 *
 * INVARIANT THIS FILE OWNS: terrain surface appearance — albedo, normal,
 * roughness, ambient occlusion and micro-detail — has exactly one owner.
 *
 * `C1`: this SUPERSEDES `TerrainMaterialPlugin`, which is deleted rather than
 * neighboured. Both plugins answered the same question and both wrote
 * `surfaceAlbedo` and `normalW`; splitting the answer across two files whose
 * composition depended on an undocumented priority number is precisely the
 * class of fragility this programme keeps finding. `3-3`'s three fixes are
 * therefore sub-steps inside this file, not a negotiation between two.
 *
 * What is here, by plan item:
 *
 *   `3-2`  the plugin, the array bindings, the regex injections, the
 *          provisional vertex splat, UVs without tangents
 *   `3-3`  micro-detail: footprint gating, real gradients, texture-sourced
 *   `3-4`  three decorrelated rotated de-tiling scales with UV warping
 *   `3-5`  triplanar texture projection, sign-flipped UVs, RNM blending
 *   `3-6`  N-way height blending with a footprint-widened transition depth
 *   `3-7`  per-material roughness, F0 and Oren-Nayar diffuse roughness, plus
 *          the wetness response wired to a constant zero until `6-5`
 *   `3-10` the `dayOfYear`-driven seasonal tint and roughness curve
 *
 * WebGPU-only by design: the renderer never compiles GLSL, and the ~90-line
 * dead GLSL branch the superseded plugin carried is deleted with it.
 *
 * NO TANGENT ATTRIBUTE (`C4`). This plugin writes `normalW` directly and
 * never enters Babylon's `NORMALMAP` path, so the tangent frame it needs is
 * the analytic one implied by its own planar XZ projection — free, and
 * flipped per plane in the triplanar branch. A vertex tangent would be memory
 * and bandwidth spent on a code path that is never compiled (assertion 58).
 *
 * NO SHADOW DEPTH WRAPPER. The vertex stage passes the splat lane through and
 * does not displace, so the depth pass is unaffected. `4-4` adds displacement
 * and must add the wrapper then, per the `0-9` incantation in
 * ARCHITECTURE.md. Stated here so nobody attaches one prematurely and nobody
 * forgets it later.
 */

/**
 * `3-4`'s de-tiling rotations: 13.7° for the patch scale and 61.2° for the
 * micro scale.
 *
 * NOT the deleted build's 36.3°. That angle is within 1.3° of the 35°
 * geological fabric the audit measures at 23.6:1 anisotropy in the geology
 * term, and aligning the de-tiling rotation with the artefact reinforces the
 * exact thing `5-8` exists to remove.
 */
export const DETILE_PATCH_DEGREES = 13.7;
export const DETILE_MICRO_DEGREES = 61.2;

/** World wavelengths of the three decorrelated de-tiling scales, metres. */
export const DETILE_MACRO_METERS = 2_048;
export const DETILE_PATCH_METERS = 176;
export const DETILE_MICRO_METERS = 28;

/**
 * Page classification is trusted only at its native 4 m channel resolution.
 * A level-1 channel texel already covers 8 m and higher levels rapidly become
 * the giant single-colour regions seen from approach altitude. Those levels
 * fall back to the continuous provisional terrain axis until a material
 * clipmap provides fine coverage independently of geometry LOD.
 */
// Wave Q (plastic-ground fix, second landing): the original 4->8 m band
// rejected every page coarser than level 0 — and in flight the finest
// resident level under the aircraft is 1-2, so the splat was OFF for
// essentially the whole frame and distant ground was a SINGLE material.
// The first widening (accept levels 0-2, binary gate) painted its own
// artifact: page confidence is piecewise-constant per level, so the last
// accepted level's border drew a razor-straight polygon edge across the
// landscape. Confidence is now LINEAR IN LOG2(texel) — one fifth lost per
// level, reaching zero at level 5 (128 m texels) — and the shader turns it
// into a noise-mottled class STRENGTH, so each level border is a ~0.2 step
// dissolved into hundred-metre ecotone mottling instead of a line.
/** A WGSL float literal for every value (`${8}.0` is fine, `${8.5}.0` is not). */
function terrainWgslFloat(value: number): string {
  if (!Number.isFinite(value)) throw new RangeError("WGSL constants must be finite");
  return Number.isInteger(value) ? `${value}.0` : String(value);
}

/**
 * `6-8`: the canopy's measured appearance, injected rather than retyped.
 *
 * Every one of these is `densityField.ts`'s — terrain does not get an opinion
 * about what a canopy looks like, and a retune on the vegetation side moves
 * the ground with it.
 */
const TERRAIN_CANOPY_ALBEDO = CANOPY_SURFACE_ALBEDO.map(terrainWgslFloat).join(", ");
const TERRAIN_CANOPY_ROUGHNESS = terrainWgslFloat(CANOPY_SURFACE_ROUGHNESS);
const TERRAIN_CANOPY_SPECULAR = terrainWgslFloat(CANOPY_SURFACE_SPECULAR);
const TERRAIN_CANOPY_AMBIENT = terrainWgslFloat(CANOPY_SURFACE_AMBIENT);
const TERRAIN_CANOPY_SHADE = terrainWgslFloat(CANOPY_UNDER_SHADE_STRENGTH);

export const TERRAIN_PAGE_SPLAT_FINEST_TEXEL_METERS = 4;
export const TERRAIN_PAGE_SPLAT_CONFIDENCE_LOSS_PER_LEVEL = 0.2;
export const TERRAIN_PAGE_SPLAT_MINIMUM_CONFIDENCE = 0.1;

/** Material microstructure is unresolved once one pixel spans this much ground. */
// Fix-pack T2: the original 0.5→2 m band, keyed to the MAJOR derivative axis,
// converged every patterned channel to a flat per-material constant within a
// few hundred metres of slant range at flight grazing angles — the reported
// plastic/clay ground. The fade now keys on the anisotropy-limited footprint
// (the minor axis the 16× sampler actually resolves) and runs to 10 m, where
// the 512-texel arrays' own mip chain has already converged to the mean.
export const TERRAIN_MATERIAL_DETAIL_FULL_FOOTPRINT_METERS = 1.5;
export const TERRAIN_MATERIAL_DETAIL_ZERO_FOOTPRINT_METERS = 10;

/** Coarse fallback's continuous alpine transition, mirroring the classifier. */
export const TERRAIN_FALLBACK_ALPINE_START_METERS = 420;
export const TERRAIN_FALLBACK_ALPINE_END_METERS = 980;
// Wave R: 0.55 -> 0.85. The classifier has NO vegetated material above
// ~900 m (lowland and warmth both die with elevation), so the fallback's
// grass base was the whole "green mountains at distance" report; a stronger
// alpine hand-over is the cheap analytic stand-in until the fallback
// evaluates the classifier's own suitabilities.
export const TERRAIN_FALLBACK_ALPINE_ROCK_STRENGTH = 0.85;

/** Pure CPU mirror of the shader's page-classification confidence. */
export function terrainPageClassificationConfidence(channelTexelMeters: number): number {
  if (!Number.isFinite(channelTexelMeters) || channelTexelMeters < 0) {
    throw new RangeError("Terrain channel texel size must be finite and non-negative");
  }
  if (channelTexelMeters <= TERRAIN_PAGE_SPLAT_FINEST_TEXEL_METERS) return 1;
  const levels = Math.log2(channelTexelMeters / TERRAIN_PAGE_SPLAT_FINEST_TEXEL_METERS);
  return Math.min(1, Math.max(0, 1 - levels * TERRAIN_PAGE_SPLAT_CONFIDENCE_LOSS_PER_LEVEL));
}

/** Pure CPU mirror of the shader's material-microstructure footprint fade. */
export function terrainMaterialDetailWeight(footprintMeters: number): number {
  if (!Number.isFinite(footprintMeters) || footprintMeters < 0) {
    throw new RangeError("Terrain footprint must be finite and non-negative");
  }
  const low = TERRAIN_MATERIAL_DETAIL_FULL_FOOTPRINT_METERS;
  const high = TERRAIN_MATERIAL_DETAIL_ZERO_FOOTPRINT_METERS;
  const t = Math.min(1, Math.max(0, (footprintMeters - low) / (high - low)));
  return 1 - t * t * (3 - 2 * t);
}

/** Pure CPU mirror of the no-page fallback's continuous Rock cover. */
export function terrainFallbackRockCover(
  elevationDriverMeters: number,
  slope: number,
): number {
  if (
    !Number.isFinite(elevationDriverMeters)
    || !Number.isFinite(slope)
    || slope < 0
    || slope > 1
  ) {
    throw new RangeError("Terrain fallback elevation/slope is outside its contract");
  }
  const altitudeT = Math.min(1, Math.max(
    0,
    (elevationDriverMeters - TERRAIN_FALLBACK_ALPINE_START_METERS)
      / (TERRAIN_FALLBACK_ALPINE_END_METERS - TERRAIN_FALLBACK_ALPINE_START_METERS),
  ));
  const alpine = altitudeT * altitudeT * (3 - 2 * altitudeT)
    * TERRAIN_FALLBACK_ALPINE_ROCK_STRENGTH;
  const slopeT = Math.min(1, Math.max(0, (slope - 0.30) / (0.66 - 0.30)));
  const slopeRock = slopeT * slopeT * (3 - 2 * slopeT);
  return Math.max(alpine, slopeRock);
}

// ---------------------------------------------------------------------------
// `6-5` — TERRAIN WETNESS: the FIELD.
//
// `3-7` shipped the RESPONSE, verbatim and live, in two instructions:
// `roughness = mix(r, r*0.35 + 0.02, wet)` and `albedo *= mix(1.0, 0.62, wet)`.
// What it never had was a driven `wet`: the uniform lane carried a constant
// zero and its setter never had a caller. Everything below is that field.
//
// THREE SOURCES, one composed maximum (wetness does not add — a surface is as
// wet as the wettest reason it has):
//
//   1. OCEAN/LAKE PROXIMITY. Under sea level the `3-7` submerged term stays
//      authoritative and is untouched. ABOVE it, the eroded world's `lakeDepth`
//      channel finally answers the case the sea-level term structurally cannot:
//      a lake at 400 m has a bed that is under water and was rendering as dry
//      SAND (the WATER biome's primary material), because `seaLevel - y` is
//      hugely negative there. `lakeDepth` is the metres of water column over
//      this texel, so it IS the lake's own submerged depth, and the signed
//      shore distance carries the same waterline out onto the dry bank.
//   2. `6-2`'s WET-SAND RUN-UP PERSISTENCE. `waterShoreWetness` is the seam,
//      and it is terrain-side for a geometric reason (D-12): the ocean disk is
//      a plane at sea level with depth write off, so on any beach above the
//      waterline the terrain fragment is nearer and the disk is depth-tested
//      away. The water surface *cannot* draw the sheet that runs up the beach
//      face; only the ground can.
//   3. CAPILLARY RISE ABOVE THE WATERLINE. Between the swash limit and dry
//      ground there is a damp band held by capillarity, and it is the term that
//      keeps a glassy sea (`R = 0`, so source 2 returns exactly 0) from drawing
//      a knife-edge waterline. ONE height constant serves both waterlines: at
//      the sea it applies to the freeboard directly; on a lake/river bank the
//      shore distance is converted to a freeboard through the terrain's own
//      gradient, which is the same beach slope source 2 already takes.
//
// NOT SEASONAL, and recorded as a decision rather than an omission. This field
// does NOT join `SEASONAL_FIELD_FAMILY` and takes no `dayOfYear` /
// `EnvironmentClock` in any signature: there is no precipitation model in this
// project, so every source above is a WATER-BODY proximity term whose driver is
// a water level and a sea state, not a calendar. §1.8's rule ("any new seasonal
// field takes the clock in a type position from FIRST write") is exactly why
// this has to be settled now rather than retrofitted — if a precipitation model
// ever lands, the honest move is a NEW field that joins the family on its first
// commit and composes with this one, not a clock threaded through this one.
// (`TerrainSurfacePlugin.ts` is itself a seasonal-family SITE for `3-10`'s
// palette; the family is keyed on artifacts, and this artifact is not one.)
// ---------------------------------------------------------------------------

/**
 * Capillary rise above a still waterline, metres.
 *
 * The capillary fringe over a water table is ~0.1 m in coarse sand, ~0.3-1 m in
 * fine sand and metres in silt; 0.35 m is a medium sand/silty margin and is the
 * one number both waterlines use. On a 1:12 beach it is a 4.2 m band; on a
 * 1:125 dissipative flat it is 44 m of damp sand, which is what those flats
 * look like.
 */
export const TERRAIN_WETNESS_CAPILLARY_RISE_METERS = 0.35;
/**
 * Lake-bed submersion ramp, metres of water column to full wetness.
 *
 * Mirrors the sea-level term's own 1 m half-width, with one deliberate
 * difference: the sea's ramp is CENTRED on its waterline because sea level is
 * an exact number, while a lake's waterline is only known through the macro
 * lake mask, so the ramp starts at the mask edge (`lakeDepth = 0`) and runs
 * inward. The bank band (source 3) supplies the outward half continuously.
 */
export const TERRAIN_WETNESS_LAKE_SUBMERGED_DEPTH_METERS = 1;
/** Guard for `slope = |grad h|` at a vertical face; 1e-4 is ~89.994°. */
export const TERRAIN_WETNESS_MINIMUM_NORMAL_Y = 1e-4;

/**
 * The freeboard above which the ocean half is EXACTLY zero, from the sea state
 * alone — one compare that buys back the swash ALU on every inland fragment.
 *
 * This is a bound, not a tuning threshold, and it is exact rather than
 * conservative-by-taste: `waterShoreWetness`'s exceedance factor is
 * `1 - smoothstep(1, 1.35, freeboard / R)`, which is identically zero at
 * `freeboard >= 1.35 R`; `R = clamp(slope) * excursion` cannot exceed
 * `0.35 * excursion` because Hunt's slope clamp caps it; and the capillary
 * fringe is identically zero past its own rise. So above the maximum of those
 * two the term cannot be non-zero for ANY slope, and skipping it changes no
 * pixel — which is what makes it an economy rather than a gate.
 *
 * For the shipped sea state (excursion 12.83 m) that is 6.06 m of freeboard:
 * every fragment of ground higher than that — including every airport, whose
 * own floor is sea level + 10 m — skips an asin, an exp, a sin and a divide.
 */
export function terrainShoreWetnessReachMeters(swashExcursionMeters: number): number {
  if (!Number.isFinite(swashExcursionMeters)) {
    throw new RangeError("Swash excursion must be finite");
  }
  return Math.max(
    TERRAIN_WETNESS_CAPILLARY_RISE_METERS,
    Math.max(0, swashExcursionMeters)
      * WATER_RUNUP_BEACH_SLOPE_MAXIMUM * WATER_RUNUP_EXCEEDANCE,
  );
}

/**
 * `smoothstep` with the reversed-pair incident's guard: a falling edge is
 * written `1 - terrainSmoothstepUnit(low, high, x)`, never by swapping the
 * bounds. The clamped form silently turns a reversed pair into a hard step.
 */
function terrainSmoothstepUnit(low: number, high: number, value: number): number {
  if (!(high > low)) {
    throw new RangeError("smoothstep bounds must satisfy high > low (write 1 - smoothstep)");
  }
  const t = Math.min(1, Math.max(0, (value - low) / (high - low)));
  return t * t * (3 - 2 * t);
}

/**
 * The beach slope `tan(beta) = |grad h|`, from the terrain's OWN geometric
 * normal at full resolution.
 *
 * D-12 is explicit that this must NOT be re-derived from the 16 m bathymetry:
 * that texel is the resolution floor the shore band had to go wide to hide,
 * and the terrain fragment already carries the real gradient. For a unit
 * normal `|grad h| = |n.xz| / n.y`, written here from `n.y` alone so the CPU
 * oracle and the WGSL twin are the same statement.
 */
export function terrainBeachSlope(normalY: number): number {
  if (!Number.isFinite(normalY)) throw new RangeError("Terrain normal y must be finite");
  const ny = Math.max(normalY, TERRAIN_WETNESS_MINIMUM_NORMAL_Y);
  return Math.sqrt(Math.max(0, 1 - ny * ny)) / ny;
}

/**
 * Source 3. `heightAboveWaterMeters` is the freeboard over whichever waterline
 * is nearest — sea level for the ocean, the lake surface for a bank. Saturated
 * at the waterline, dry at the top of the fringe, and continuous through zero
 * so it joins the submerged term without a seam.
 */
export function terrainCapillaryWetness(heightAboveWaterMeters: number): number {
  if (!Number.isFinite(heightAboveWaterMeters)) {
    throw new RangeError("Capillary height must be finite");
  }
  return 1 - terrainSmoothstepUnit(
    0,
    TERRAIN_WETNESS_CAPILLARY_RISE_METERS,
    heightAboveWaterMeters,
  );
}

/** `3-7`'s sea-level submerged fraction, unchanged — the CPU twin of it. */
export function terrainSeaSubmergedFraction(freeboardMeters: number): number {
  if (!Number.isFinite(freeboardMeters)) throw new RangeError("Freeboard must be finite");
  return Math.min(1, Math.max(0, -freeboardMeters * 0.5 + 0.5));
}

/** Source 1's lake half: metres of water column over this texel, as a fraction. */
export function terrainLakeSubmergedFraction(lakeDepthMeters: number): number {
  if (!Number.isFinite(lakeDepthMeters)) throw new RangeError("Lake depth must be finite");
  return Math.min(
    1,
    Math.max(0, lakeDepthMeters / TERRAIN_WETNESS_LAKE_SUBMERGED_DEPTH_METERS),
  );
}

/**
 * Source 1's bank half: the capillary fringe around an inland waterline, with
 * the signed shore distance converted to a freeboard through the terrain's own
 * gradient. Inside the water (`shoreDistance <= 0`) the product is negative and
 * the fringe reads 1, so the band is continuous across the waterline rather
 * than starting at it.
 *
 * The slope uses Hunt's own clamps, so a marsh (flat) reads wet across its
 * whole flat and a cut bank (steep) reads wet for a hand's width — the physical
 * behaviour, from the same two numbers `6-2` regressed its run-up on.
 */
export function terrainBankWetness(
  shoreDistanceMeters: number,
  beachSlope: number,
): number {
  if (!Number.isFinite(shoreDistanceMeters) || !Number.isFinite(beachSlope)) {
    throw new RangeError("Bank wetness inputs must be finite");
  }
  const slope = Math.min(
    WATER_RUNUP_BEACH_SLOPE_MAXIMUM,
    Math.max(WATER_RUNUP_BEACH_SLOPE_MINIMUM, beachSlope),
  );
  return terrainCapillaryWetness(shoreDistanceMeters * slope);
}

/** Everything `6-5` needs at one fragment; nulls are the unbound channels. */
export interface TerrainWetnessInput {
  /** Ground elevation minus STILL water level, positive above the waterline. */
  readonly freeboardMeters: number;
  /** `tan(beta)` from the terrain's own geometric normal. */
  readonly beachSlope: number;
  /** `6-2`'s Hunt excursion `sqrt(H L0)`; zero for a glassy sea. */
  readonly swashExcursionMeters: number;
  /** The swell's single temporal frequency — the phase lock. */
  readonly radianFrequency: number;
  /** The wrapped run-up clock, seconds. */
  readonly runupClockSeconds: number;
  /** Eroded-only: metres of lake water over this texel. Null = channel unbound. */
  readonly lakeDepthMeters: number | null;
  /** Eroded-only: signed metres to the nearest lake edge. Null = unbound. */
  readonly shoreDistanceMeters: number | null;
}

/** What the two `3-7` response instructions and the silt tint read. */
export interface TerrainWetnessField {
  /** Drives roughness and albedo; exactly [0, 1]. */
  readonly wetness: number;
  /** Drives the water-column silt/biofilm tint; exactly [0, 1]. */
  readonly submerged: number;
}

/**
 * The composed field, statement for statement with its WGSL twin below.
 *
 * `wetness` is a MAXIMUM, not a sum: ground is as wet as the wettest reason it
 * has, and a maximum of terms each in [0, 1] cannot leave [0, 1] — which is
 * what keeps the `3-7` response inside the range it was tuned on without a
 * saturating clamp hiding a term that ran away.
 *
 * `submerged` carries only the two terms that mean "there is a water COLUMN
 * over this ground" — sea level and lake depth. Wet sand is wet, not tinted:
 * the silt/biofilm/absorption mix belongs to a bed under water, and applying it
 * to a swash band would paint the beach green.
 */
export function terrainWetnessField(input: TerrainWetnessInput): TerrainWetnessField {
  const {
    freeboardMeters,
    beachSlope,
    swashExcursionMeters,
    radianFrequency,
    runupClockSeconds,
    lakeDepthMeters,
    shoreDistanceMeters,
  } = input;
  const shore = terrainShoreWetness(
    freeboardMeters,
    beachSlope,
    swashExcursionMeters,
    radianFrequency,
    runupClockSeconds,
  );
  const seaSubmerged = terrainSeaSubmergedFraction(freeboardMeters);
  // The eroded-only half. A null channel contributes exactly zero, which is
  // what makes an analytic world's field the sea-level band alone.
  const lakeSubmerged = lakeDepthMeters === null
    ? 0
    : terrainLakeSubmergedFraction(lakeDepthMeters);
  const bank = shoreDistanceMeters === null
    ? 0
    : terrainBankWetness(shoreDistanceMeters, beachSlope);
  const submerged = Math.max(seaSubmerged, lakeSubmerged);
  return {
    wetness: Math.min(1, Math.max(
      Math.max(submerged, shore),
      bank,
    )),
    submerged,
  };
}

/**
 * The OCEAN half — sources 2 and 3 at sea level, as one function so the CPU
 * oracle and the WGSL twin share a shape as well as a result.
 */
export function terrainShoreWetness(
  freeboardMeters: number,
  beachSlope: number,
  swashExcursionMeters: number,
  radianFrequency: number,
  runupClockSeconds: number,
): number {
  if (
    !Number.isFinite(freeboardMeters)
    || !Number.isFinite(beachSlope)
    || !Number.isFinite(radianFrequency)
    || !Number.isFinite(runupClockSeconds)
  ) {
    throw new RangeError("Shore wetness inputs must be finite");
  }
  // The exact early-out; see `terrainShoreWetnessReachMeters`.
  if (freeboardMeters > terrainShoreWetnessReachMeters(swashExcursionMeters)) return 0;
  const swell: WaterShoreSwell = {
    waveHeightMeters: 0,
    wavelengthMeters: 1,
    radianFrequency,
    excursionMeters: Math.max(0, swashExcursionMeters),
  };
  const swashHeight = waterShoreRunupHeight(swell, beachSlope);
  // Above the waterline the still-water depth is negative, so the eikonal's
  // travel time clamps to zero and the whole swash zone beats together: a bore
  // that has crossed the waterline is one sheet, not a train (D-12).
  const phase = waterShoreRunupPhase(
    -freeboardMeters,
    beachSlope,
    radianFrequency,
    runupClockSeconds,
  );
  const swash = waterShoreWetness(freeboardMeters, swashHeight, phase, radianFrequency);
  return Math.max(swash, terrainCapillaryWetness(freeboardMeters));
}

/** Height-gradient scales from atlas-texel space into the unit node mesh. */
export const TERRAIN_FINE_HEIGHT_GRADIENT_SCALE = TERRAIN_NODE_GRID_RESOLUTION - 1;
export const TERRAIN_PARENT_HEIGHT_GRADIENT_SCALE =
  TERRAIN_FINE_HEIGHT_GRADIENT_SCALE / 2;

/**
 * CPU mirror of the CDLOD vertex shader's macro-normal construction.
 *
 * Gradients arrive in metres of rise per atlas texel. The fine page spans
 * 32 texels across a unit node; its parent spans 16. Babylon subsequently
 * applies the thin instance's inverse-transpose, proportional to
 * (1 / span, 1, 1 / span), turning this unit-node normal into the correct
 * world-space slope before interpolation.
 */
export function terrainNodeLocalNormalFromHeightGradients(
  fineGradient: readonly [number, number],
  parentGradient: readonly [number, number],
  morphK: number,
  fineResident = true,
): readonly [number, number, number] {
  const values = [...fineGradient, ...parentGradient, morphK];
  if (values.some((value) => !Number.isFinite(value)) || morphK < 0 || morphK > 1) {
    throw new RangeError("Terrain height gradients must be finite and morphK must be in [0, 1]");
  }
  const parentX = parentGradient[0] * TERRAIN_PARENT_HEIGHT_GRADIENT_SCALE;
  const parentZ = parentGradient[1] * TERRAIN_PARENT_HEIGHT_GRADIENT_SCALE;
  const fineX = fineResident
    ? fineGradient[0] * TERRAIN_FINE_HEIGHT_GRADIENT_SCALE
    : parentX;
  const fineZ = fineResident
    ? fineGradient[1] * TERRAIN_FINE_HEIGHT_GRADIENT_SCALE
    : parentZ;
  const gradientX = fineX + (parentX - fineX) * morphK;
  const gradientZ = fineZ + (parentZ - fineZ) * morphK;
  const length = Math.hypot(gradientX, 1, gradientZ);
  return [-gradientX / length, 1 / length, -gradientZ / length];
}

/**
 * The phase's first tuning knob. At 1.6 the three scales warp the material UV
 * by up to ~58 m, decorrelating every tiling period in the 3-0 table
 * (2.3–8.9 m) many times over; the worst local stretch is the micro scale's,
 * at ~16%, which is below where a warp starts reading as a smear.
 *
 * Tuned against the `approach-500ft` capture: at 1.0 the far ground still
 * carried a visible repeat.
 */
export const DEFAULT_DETILE_WARP = 1.6;

/**
 * The phase's second tuning knob: `3-6`'s height-blend transition depth,
 * `d = mix(0.06, 0.5, saturate(fp / 3))`. It widens with the footprint so the
 * blend does not alias at distance.
 */
export const HEIGHT_BLEND_DEPTH_NEAR = 0.06;
export const HEIGHT_BLEND_DEPTH_FAR = 0.5;

/**
 * Maximum footprint anisotropy the surface sampler will ask for, matched to
 * the arrays' `anisotropicFilteringLevel`. See `terrainSurfaceLimitAnisotropy`.
 * Fix-pack T3: this claimed to match the sampler and did not — the arrays are
 * uploaded at 16× (`SURFACE_ARRAY_ANISOTROPY`), so the 12 here inflated the
 * minor axis beyond what the hardware needed and blurred the mid-range.
 */
export const DEFAULT_ANISOTROPY_LIMIT = 16;

/** `3-5`: triplanar engages above this slope (`1 − |n.y|`). */
export const TRIPLANAR_SLOPE_THRESHOLD = 0.22;

// ---------------------------------------------------------------------------
// 3-10 — the seasonal palette.
//
// Per ARCHITECTURE.md §4's threading rule, `dayOfYear` is in the response
// function's signature from the first line, never as a retrofit; the boundary
// test checks this file for it as it comes into existence.
//
// A tint and roughness curve sampled per material — NOT new texture arrays.
// The arrays stay season-independent and only their weighting changes, which
// is what keeps the §5.2 memory row flat while `2-18` competes for the same
// headroom.
// ---------------------------------------------------------------------------

export interface SurfaceSeasonalResponse {
  /** Multiplicative tint on the material's albedo. */
  readonly tint: readonly [number, number, number];
  /** Added to the material's sampled roughness. */
  readonly roughnessDelta: number;
}

const NEUTRAL_RESPONSE: SurfaceSeasonalResponse = Object.freeze({
  tint: Object.freeze([1, 1, 1]) as readonly [number, number, number],
  roughnessDelta: 0,
});

/** Season anchors: day of year in the northern hemisphere, tint, roughness delta. */
const SEASON_ANCHORS: readonly {
  readonly day: number;
  readonly tint: readonly [number, number, number];
  readonly roughnessDelta: number;
}[] = Object.freeze([
  // Spring flush: fresh chlorophyll, and wet ground — the darkening and the
  // gloss both belong to the same fortnight.
  { day: 110, tint: [0.78, 0.98, 0.7], roughnessDelta: -0.07 },
  { day: 199, tint: [1, 1, 1], roughnessDelta: 0 },
  { day: 290, tint: [1.38, 1.02, 0.6], roughnessDelta: 0.03 },
  { day: 15, tint: [1.12, 0.92, 0.7], roughnessDelta: 0.05 },
]);

function seasonWeights(dayOfYear: number, latitudeDegrees: number): number[] {
  // Southern hemisphere: the same curve, half a year out of phase.
  const shifted = latitudeDegrees >= 0 ? dayOfYear : dayOfYear + 365 / 2;
  const weights: number[] = [];
  let total = 0;
  for (const anchor of SEASON_ANCHORS) {
    let delta = (((shifted - anchor.day) % 365) + 365) % 365;
    if (delta > 365 / 2) delta -= 365;
    // A raised cosine over ±½ year, sharpened so an anchor dominates its own
    // season instead of every anchor contributing everywhere.
    const lobe = Math.max(0, Math.cos((delta / 365) * Math.PI * 2)) ** 3;
    weights.push(lobe);
    total += lobe;
  }
  if (total <= 1e-6) return SEASON_ANCHORS.map((_, index) => (index === 1 ? 1 : 0));
  return weights.map((weight) => weight / total);
}

function blendedSeason(dayOfYear: number, latitudeDegrees: number): SurfaceSeasonalResponse {
  const weights = seasonWeights(dayOfYear, latitudeDegrees);
  let r = 0;
  let g = 0;
  let b = 0;
  let roughnessDelta = 0;
  SEASON_ANCHORS.forEach((anchor, index) => {
    const weight = weights[index] ?? 0;
    r += anchor.tint[0] * weight;
    g += anchor.tint[1] * weight;
    b += anchor.tint[2] * weight;
    roughnessDelta += anchor.roughnessDelta * weight;
  });
  return { tint: [r, g, b], roughnessDelta };
}

/**
 * The per-material seasonal response.
 *
 * ANCHORED at `TERRAIN_REFERENCE_DAY_OF_YEAR`, exactly as `R-13`'s kernel
 * terms are: the raw curve is divided by its own value at the reference day,
 * so at the midsummer default clock the response is precisely (1, 1, 1) and 0
 * and the tuned shipped world is bit-identical. Winter, spring and autumn are
 * expressed as deviations from that tuned state rather than as a new one.
 *
 * Rock, asphalt and concrete are season-invariant — the `seasonal` flag in
 * the `3-0` contract, not a list repeated here.
 */
export function surfaceSeasonalResponse(
  spec: SurfaceMaterialSpec,
  dayOfYear: number,
  latitudeDegrees: number,
): SurfaceSeasonalResponse {
  if (!spec.seasonal) return NEUTRAL_RESPONSE;
  const current = blendedSeason(dayOfYear, latitudeDegrees);
  const reference = blendedSeason(TERRAIN_REFERENCE_DAY_OF_YEAR, latitudeDegrees);
  // Dry grass has already made the autumn move; it rides a damped curve so it
  // does not double-count into orange.
  const damping = spec.id === SurfaceMaterial.DryGrass ? 0.45
    : spec.id === SurfaceMaterial.ForestFloor ? 0.6
      : 1;
  const tint: [number, number, number] = [0, 0, 0];
  for (let channel = 0; channel < 3; channel += 1) {
    const ratio = current.tint[channel]! / Math.max(1e-4, reference.tint[channel]!);
    tint[channel] = 1 + (ratio - 1) * damping;
  }
  return {
    tint,
    roughnessDelta: (current.roughnessDelta - reference.roughnessDelta) * damping,
  };
}

/**
 * `R-26`: the scene-scale mean surface albedo the light rig's ground bounce is
 * derived from, with the seasonal tint applied. This is the number that
 * retires deviation `D-6`'s hardcoded 0.25 SH floor and `D-9`'s surviving
 * light-rig palette row — both ground-bounce fakes tuned against a ground
 * colour this phase replaces.
 */
export function meanSeasonalSurfaceAlbedo(
  dayOfYear: number,
  latitudeDegrees: number,
): readonly [number, number, number] {
  const winter = seasonalWinterFraction(dayOfYear, latitudeDegrees);
  const base = meanSurfaceAlbedo(winter);
  // The winter fraction already moved snow's share of the cover; the tint
  // moves the colour of what is left — weighted by the SAME land-cover shares
  // the albedo is. Averaging the tint over all ten materials unweighted lets
  // the six season-invariant ones (rock, gravel, sand, snow and the two paved)
  // halve the swing that four seasonal covers are trying to express.
  const shares = landCoverShare(winter);
  let r = 0;
  let g = 0;
  let b = 0;
  let total = 0;
  SURFACE_MATERIALS.forEach((spec, index) => {
    const share = shares[index] ?? 0;
    const response = surfaceSeasonalResponse(spec, dayOfYear, latitudeDegrees);
    r += response.tint[0] * share;
    g += response.tint[1] * share;
    b += response.tint[2] * share;
    total += share;
  });
  const scale = total > 0 ? [r / total, g / total, b / total] : [1, 1, 1];
  return [
    Math.min(1, base[0] * scale[0]!),
    Math.min(1, base[1] * scale[1]!),
    Math.min(1, base[2] * scale[2]!),
  ];
}

/**
 * `3-6`'s height blend, as a TS mirror of the WGSL.
 *
 * `k_i = h_i + w_i`; `b_i = max(k_i − (max k − d), 0)`; normalise. Assertion 60
 * checks this is a partition of unity for randomised inputs — a blend that
 * quietly loses energy darkens the whole terrain and is very hard to see by
 * eye, which is exactly why it is asserted rather than reviewed.
 *
 * The shader implements the same three lines inline (a `vec3f` version and a
 * `vec2f` version under the tier's material cap) rather than calling a shared
 * WGSL function, so this mirror is the falsifiable statement of the property
 * and the shader's tokens are pinned against it by test.
 */
export function heightBlendWeights(keys: readonly number[], depth: number): number[] {
  if (keys.length === 0) return [];
  const threshold = Math.max(...keys) - depth;
  const raw = keys.map((key) => Math.max(key - threshold, 0));
  const sum = Math.max(raw.reduce((total, value) => total + value, 0), 1e-5);
  return raw.map((value) => value / sum);
}

export interface TerrainSlopeSnowCover {
  readonly materialId: typeof SurfaceMaterial.Rock | typeof SurfaceMaterial.Snow;
  readonly weight: number;
}

/**
 * Resolve the mutually exclusive part of slope-exposed rock and seasonal snow.
 *
 * Both inputs describe cover of the same surface area. Selecting the larger
 * input while retaining its full weight made an infinitesimal crossover jump
 * from almost-opaque snow to almost-opaque dark rock. The signed residual is
 * continuous: snow owns positive cover, exposed rock owns negative cover, and
 * at the ownership boundary the third candidate has zero influence.
 */
export function resolveTerrainSlopeSnowCover(
  slopeRock: number,
  snowCover: number,
): TerrainSlopeSnowCover {
  if (
    !Number.isFinite(slopeRock)
    || !Number.isFinite(snowCover)
    || slopeRock < 0
    || slopeRock > 1
    || snowCover < 0
    || snowCover > 1
  ) {
    throw new RangeError("Terrain slope-rock and snow cover must be finite values in [0, 1]");
  }
  const coverDelta = snowCover - slopeRock;
  return {
    materialId: coverDelta > 0 ? SurfaceMaterial.Snow : SurfaceMaterial.Rock,
    weight: Math.abs(coverDelta),
  };
}

/** CPU mirror of the height blend's continuity gate for slope/snow cover. */
export function terrainCoverHeightBlendWeights(
  baseKeys: readonly number[],
  thirdHeight: number,
  thirdWeight: number,
  depth: number,
): number[] {
  if (
    baseKeys.length < 1
    || baseKeys.length > 2
    || baseKeys.some((value) => !Number.isFinite(value))
    || !Number.isFinite(thirdHeight)
    || !Number.isFinite(thirdWeight)
    || !Number.isFinite(depth)
    || thirdHeight < 0
    || thirdHeight > 1
    || thirdWeight < 0
    || thirdWeight > 1
    || depth <= 0
  ) {
    throw new RangeError("Terrain cover height-blend inputs are outside their contract");
  }
  const thirdKey = thirdWeight > 0 ? thirdWeight * (thirdHeight + 1) : -1e9;
  const keys = [...baseKeys, thirdKey];
  const threshold = Math.max(...keys) - depth;
  const raw = keys.map((key) => Math.max(key - threshold, 0));
  raw[raw.length - 1]! *= thirdWeight;
  const sum = Math.max(raw.reduce((total, value) => total + value, 0), 1e-5);
  return raw.map((value) => value / sum);
}

/** The snowline altitude the shader blankets above, metres above sea level. */
export function seasonalSnowlineMeters(
  seaLevelMeters: number,
  dayOfYear: number,
  latitudeDegrees: number,
): number {
  return seaLevelMeters + TERRAIN_REFERENCE_SNOWLINE_OFFSET_METERS
    - seasonalSnowlineDescentMeters(dayOfYear, latitudeDegrees);
}

// ---------------------------------------------------------------------------
// The shader. WGSL only.
// ---------------------------------------------------------------------------

const PATCH_COS = Math.cos((DETILE_PATCH_DEGREES * Math.PI) / 180).toFixed(6);
const PATCH_SIN = Math.sin((DETILE_PATCH_DEGREES * Math.PI) / 180).toFixed(6);
const MICRO_COS = Math.cos((DETILE_MICRO_DEGREES * Math.PI) / 180).toFixed(6);
const MICRO_SIN = Math.sin((DETILE_MICRO_DEGREES * Math.PI) / 180).toFixed(6);

const TERRAIN_MATERIAL_REFERENCE_WGSL = SURFACE_MATERIALS.map((spec) => {
  // Wave Q (plastic-ground fix): the convergence target at range is the
  // band's ROUGH end, not its midpoint. As detailWeight fades, the detail
  // normal flattens to the geometric normal, and the microstructure that
  // vanished has to be re-expressed as roughness (the Toksvig argument in
  // TextureArrayMips.ts) — converging to the glossy midpoint under a flat
  // normal was the "false sharp highlight at range" that file warns about.
  const roughness = spec.roughness[1];
  return `
  if (materialIndex == ${spec.id}) {
    return vec4f(${spec.referenceAlbedo.map((value) => value.toFixed(6)).join(", ")}, ${roughness.toFixed(6)});
  }`;
}).join("");

/**
 * Shipping boundary decoder, exported so the real-adapter seam oracle runs
 * the exact WGSL used by the material rather than a test transcription.
 */
export const TERRAIN_BOUNDARY_MORPH_WGSL = /* wgsl */ `
/** Decode four six-bit UNORM factors from one exactly representable f32 integer. */
fn terrainSurfaceCornerMorphs(packed: f32) -> vec4f {
  let bits = u32(round(clamp(packed, 0.0, ${TERRAIN_CORNER_MORPH_PACKED_MAX}.0)));
  let mask = ${TERRAIN_CORNER_MORPH_LEVELS}u;
  let scale = 1.0 / ${TERRAIN_CORNER_MORPH_LEVELS}.0;
  return vec4f(
    f32(bits & mask),
    f32((bits >> ${TERRAIN_CORNER_MORPH_BITS}u) & mask),
    f32((bits >> ${TERRAIN_CORNER_MORPH_BITS * 2}u) & mask),
    f32((bits >> ${TERRAIN_CORNER_MORPH_BITS * 3}u) & mask)
  ) * scale;
}

/**
 * Interior vertices keep the node's continuous K. Each shared boundary uses
 * the line through its two synchronized corner factors. The CPU makes those
 * endpoints identical for same-level peers and complementary (fine=1,
 * coarse=0) across a 2:1 edge.
 */
fn terrainSurfaceVertexMorphK(
  nodeMorphK: f32,
  packedCorners: f32,
  gridPosition: vec2f,
  parentResident: bool,
) -> f32 {
  if (!parentResident) { return 0.0; }
  let quads = ${TERRAIN_NODE_GRID_RESOLUTION - 1}.0;
  let onX0 = gridPosition.x < 0.5;
  let onX1 = gridPosition.x > quads - 0.5;
  let onZ0 = gridPosition.y < 0.5;
  let onZ1 = gridPosition.y > quads - 0.5;
  // 31x31 of the 33x33 grid vertices are strict interior vertices. Their
  // morph is node-local, so avoid unpacking four boundary-only factors for
  // the overwhelming majority of vertex invocations.
  if (!(onX0 || onX1 || onZ0 || onZ1)) {
    return clamp(nodeMorphK, 0.0, 1.0);
  }
  let corners = terrainSurfaceCornerMorphs(packedCorners);
  // Exact endpoints prevent one-ULP disagreement when incident nodes reach
  // the same world corner from different edge interpolation directions.
  if (onX0 && onZ0) { return corners.x; }
  if (onX1 && onZ0) { return corners.y; }
  if (onX0 && onZ1) { return corners.z; }
  if (onX1 && onZ1) {
    return corners.w;
  }
  if (onX0) {
    return mix(corners.x, corners.z, gridPosition.y / quads);
  }
  if (onX1) {
    return mix(corners.y, corners.w, gridPosition.y / quads);
  }
  if (onZ0) {
    return mix(corners.x, corners.y, gridPosition.x / quads);
  }
  if (onZ1) {
    return mix(corners.z, corners.w, gridPosition.x / quads);
  }
  // All strict interior vertices returned before decoding packedCorners.
  return clamp(nodeMorphK, 0.0, 1.0);
}
`;

export const TERRAIN_SURFACE_VERTEX_WGSL = Object.freeze({
  CUSTOM_VERTEX_DEFINITIONS: /* wgsl */ `
#ifdef TERRAIN_SURFACE_CDLOD
// 4-5's node record. TWO stride-4 attributes, never one stride-8: a custom
// kind resolves to _size = 8 inside VertexBuffer and
// WebGPUCacheRenderPipeline throws "Invalid Format ... size=8", because
// WebGPU has no vertex format wider than four components.
//   A = (slotIndex, subNodeX + subNodeZ*8, level, provisionalAxisOverride)
//   B = (morphK, parentSlotIndex, channelLane, packedCornerMorphs)
attribute terrainNodeA: vec4f;
attribute terrainNodeB: vec4f;
// 4-4: vertex-texture displacement. Sampled with textureLoad ONLY — r32float
// is unfilterable (float32-filterable is available and deliberately not
// requested), and the geomorph wants exact texel values at snapped lattice
// positions anyway.
var terrainHeightAtlas: texture_2d<f32>;

/**
 * Bilinear height and its analytic texel-space gradient from the same four
 * textureLoads. xyz = (height, dH/dTexelX, dH/dTexelZ).
 */
fn terrainSampleHeightGradient(slot: f32, texelX: f32, texelZ: f32) -> vec3f {
  if (slot < 0.0) { return vec3f(0.0); }
  let grid = uniforms.terrainHeightAtlasShape.w;
  let row = floor(slot / grid);
  let slotOrigin = vec2f(slot - row * grid, row) * uniforms.terrainHeightAtlasShape.y
    + vec2f(uniforms.terrainHeightAtlasShape.z);
  let base = floor(vec2f(texelX, texelZ));
  let fraction = vec2f(texelX, texelZ) - base;
  let corner = vec2i(slotOrigin + base);
  let h00 = textureLoad(terrainHeightAtlas, corner, 0).r;
  let h10 = textureLoad(terrainHeightAtlas, corner + vec2i(1, 0), 0).r;
  let h01 = textureLoad(terrainHeightAtlas, corner + vec2i(0, 1), 0).r;
  let h11 = textureLoad(terrainHeightAtlas, corner + vec2i(1, 1), 0).r;
  let top = h00 + (h10 - h00) * fraction.x;
  let bottom = h01 + (h11 - h01) * fraction.x;
  let gradientX = mix(h10 - h00, h11 - h01, fraction.y);
  let gradientZ = mix(h01 - h00, h11 - h10, fraction.x);
  return vec3f(top + (bottom - top) * fraction.y, gradientX, gradientZ);
}

${TERRAIN_BOUNDARY_MORPH_WGSL}
#else
// 3-2's provisional splat rides the colour attribute the clipmap already
// allocated. useVertexColors is false on those meshes, so VERTEXCOLOR is
// never defined and this lane is the plugin's alone:
//   x = primary material id, y = secondary material id, z = secondary weight,
//   w = atlasSlot, written as -1 until 4-2 fills it.
// The ids are CONTINUOUS along the SurfaceMaterial axis and the fragment
// brackets them; see the contract's note on why that order is load-bearing.
attribute color: vec4f;
#endif
#if defined(TERRAIN_SURFACE_CDLOD) && defined(TERRAIN_SURFACE_PAGE_CHANNELS)
${VEGETATION_CANOPY_HANDOFF_WGSL}
// 6-8: the canopy-closure channel, in the VERTEX stage.
//
// textureLoad, not textureSample: the vertex stage takes no sampler here for
// the same reason the height atlas does not, and four exact loads give the
// bilinear the lift needs without a blocky step at every channel texel.
var terrainSplatWeightLo: texture_2d<f32>;

fn terrainVertexCanopyClosure(lane: f32, pageLocalMeters: vec2f) -> f32 {
  if (lane < 0.0) { return 0.0; }
  let slot = floor(lane * ${1 / 32});
  let level = lane - slot * 32.0;
  let extent = uniforms.terrainPageAtlasGrid.y * exp2(level);
  let grid = uniforms.terrainPageAtlasGrid.x;
  let row = floor(slot / grid);
  let slotOrigin = vec2f(slot - row * grid, row) * uniforms.terrainPageAtlas.y;
  let core = uniforms.terrainPageAtlas.z;
  let inPage = clamp(pageLocalMeters / extent, vec2f(0.0), vec2f(1.0));
  let atlasPosition = slotOrigin + vec2f(uniforms.terrainPageAtlas.w)
    + inPage * core - vec2f(0.5);
  let base = floor(atlasPosition);
  let fraction = atlasPosition - base;
  let corner = vec2i(base);
  let a00 = textureLoad(terrainSplatWeightLo, corner, 0).a;
  let a10 = textureLoad(terrainSplatWeightLo, corner + vec2i(1, 0), 0).a;
  let a01 = textureLoad(terrainSplatWeightLo, corner + vec2i(0, 1), 0).a;
  let a11 = textureLoad(terrainSplatWeightLo, corner + vec2i(1, 1), 0).a;
  let top = a00 + (a10 - a00) * fraction.x;
  let bottom = a01 + (a11 - a01) * fraction.x;
  return clamp(top + (bottom - top) * fraction.y, 0.0, 1.0);
}
#endif
varying terrainSplat: vec4f;
// 4-7: the vertex's position INSIDE its page, in metres. The page meshes are
// built page-local and positioned by their world matrix, so this is free —
// and it is what lets the fragment address the channel atlas without a
// per-mesh uniform on a material every page shares.
varying terrainPageLocal: vec2f;
`,
  /**
   * `4-4`: displacement at `CUSTOM_VERTEX_UPDATE_POSITION`, and the hook
   * choice is load-bearing rather than stylistic.
   *
   * `pbr.vertex` assigns `vPositionW = worldPos.xyz` and computes `vNormalW`
   * BEFORE the `CUSTOM_VERTEX_UPDATE_WORLDPOS` marker. Displacing there moves
   * the rasterised geometry but leaves `vPositionW` at the undisplaced height
   * — and `vPositionW` is what the aerial-perspective include, the
   * cloud-shadow plugin and the triplanar projection all read. The symptom is
   * haze and cloud shadows sitting at the wrong altitude on every slope, which
   * reads as a lighting bug and is not one.
   */
  CUSTOM_VERTEX_UPDATE_POSITION: /* wgsl */ `
#ifdef TERRAIN_SURFACE_CDLOD
{
  let nodeA = vertexInputs.terrainNodeA;
  let nodeB = vertexInputs.terrainNodeB;
  let quads = ${TERRAIN_NODE_GRID_RESOLUTION - 1}.0;
  // The geomorph, in the node's OWN grid coordinates. At morphK = 1 every odd
  // vertex has collapsed onto the previous even one, which is exactly the
  // parent's lattice — so the two edges are the same curve and cracks close
  // ANALYTICALLY. That is what lets skirts be deleted, which is what lets
  // backFaceCulling be true.
  let gridPosition = positionUpdated.xz * quads;
  let vertexMorphK = terrainSurfaceVertexMorphK(
    nodeB.x, nodeB.w, gridPosition, nodeB.y >= 0.0);
  let evenLattice = floor(gridPosition * 0.5) * 2.0;
  let morphed = (gridPosition + (evenLattice - gridPosition) * vertexMorphK) / quads;
  positionUpdated.x = morphed.x;
  positionUpdated.z = morphed.y;

  // One 264-texel slot serves an 8x8 block of nodes, and a node spans 32
  // quads, so a node vertex lands on a page texel exactly: no rounding, no
  // half-texel convention to get wrong.
  let parityZ = floor(nodeA.y * 0.0078125);
  let afterZ = nodeA.y - parityZ * 128.0;
  let parityX = floor(afterZ * 0.015625);
  let subIndex = afterZ - parityX * 64.0;
  let subZ = floor(subIndex * 0.125);
  let subX = subIndex - subZ * 8.0;

  let nodeTexel = (vec2f(subX, subZ) + morphed) * quads;
  // The parent page is one level coarser — half the texel density — and this
  // node sits in one quadrant of its parent page's 8x8 node block. At
  // morphK = 1 morphed*quads is even, so morphed*16 is an integer and
  // this load is an EXACT parent texel: the child's edge is the parent's, by
  // construction rather than by tuning.
  let fineResident = nodeA.x >= 0.0;
  let sampledFine = terrainSampleHeightGradient(nodeA.x, nodeTexel.x, nodeTexel.y);
  // With an exact zero morph and a resident fine page the parent contributes
  // to neither height nor normal. Avoid four redundant vertex texture loads
  // in that common near-field case. A missing fine page must still inherit
  // its parent, and every non-zero synchronized edge factor still samples it.
  var coarse = sampledFine;
  if (vertexMorphK > 0.0 || !fineResident) {
    let parentTexel = vec2f(parityX, parityZ) * 128.0
      + vec2f(subX, subZ) * 16.0
      + morphed * (quads * 0.5);
    coarse = terrainSampleHeightGradient(nodeB.y, parentTexel.x, parentTexel.y);
  }
  // A node may survive one publication frame after its fine page is evicted.
  // Its parent is admitted independently and is the only geometrically
  // coherent fallback. Returning the helper's zero here made a whole node
  // collapse to sea level until the fine slot returned.
  let fine = select(coarse, sampledFine, fineResident);
  positionUpdated.y = fine.x + (coarse.x - fine.x) * vertexMorphK;


  // The atlas sampler already has the four bilinear corners in registers, so
  // its analytic gradient supplies a smooth shared-vertex normal at no extra
  // texture-load cost. Fine texels span 1/32 of a node; parent texels span
  // 1/16. Select the parent's scale with its fallback, then morph normals by
  // the same k as height. At k=1 this is exactly the adjacent coarse node's
  // normal after its 2x larger world matrix is applied, preserving LOD seams.
  let parentGradient = coarse.yz * (quads * 0.5);
  let fineGradient = select(parentGradient, sampledFine.yz * quads, fineResident);
  let nodeGradient = fineGradient + (parentGradient - fineGradient) * vertexMorphK;
#ifdef NORMAL
  // Babylon applies the inverse-scale/world transform and normalizes the
  // result in both PBR and shadow-map vertex pipelines. Pre-normalizing here
  // is a uniform scalar that cancels at that mandatory final normalize, so it
  // only repeats a dot/rsqrt for every terrain vertex and cascade.
  normalUpdated = vec3f(-nodeGradient.x, 1.0, -nodeGradient.y);
#endif
}
#endif
`,
  /**
   * `6-8` — the canopy's SILHOUETTE, at coarse LOD only.
   *
   * A forested ridgeline seen from 4 km is 20 m of canopy sitting on the rock,
   * and past the impostor radius nothing draws it. The lift rides the SAME
   * handoff law as the appearance ramp, so geometry and shading hand over
   * together, times a NYQUIST gate on the node's own level: a lift the vertex
   * grid can resolve would fight the trees drawn on top of it, and the whole
   * justification for adding canopy to terrain HEIGHT is that at level 4 and up
   * (32 m+ between vertices) canopy structure is below the lattice's Nyquist
   * limit and can only be carried as bulk.
   *
   * **The hook is `CUSTOM_VERTEX_UPDATE_WORLDPOS`, not
   * `CUSTOM_VERTEX_UPDATE_POSITION`, and that is load-bearing in both
   * directions.** The position hook is emitted BEFORE `instancesVertex`, so
   * `finalWorld` does not exist there and a camera range would have to
   * re-derive the thin-instance matrix — mirroring Babylon-internal shipped
   * WGSL, which the decision log already records as a thing that breaks on a
   * version bump. Here `worldPos` is in hand. The reason `4-4` warns against
   * this hook — that it moves geometry while leaving `vPositionW` behind, so
   * haze and cloud shadows sit at the wrong altitude — is discharged by
   * reassigning `vPositionW` immediately, which is exactly what that warning
   * asks for and what the displacement path could not do.
   *
   * Cracks: the closure channel is band-limited at a FIXED 60 m rather than per
   * page (`CANOPY_CLOSURE_FILTER_WIDTH_METERS`), so two nodes at different
   * levels meeting along an edge read the same continuous field and their lifts
   * agree to bilinear resampling error rather than to a level-dependent band
   * weight. That is the property that makes a vertex-stage lift safe where a
   * per-page baked one would open a seam.
   */
  CUSTOM_VERTEX_UPDATE_WORLDPOS: /* wgsl */ `
#if defined(TERRAIN_SURFACE_CDLOD) && defined(TERRAIN_SURFACE_PAGE_CHANNELS)
{
  let canopySubIndex = vertexInputs.terrainNodeA.y
    - floor(vertexInputs.terrainNodeA.y * 0.015625) * 64.0;
  let canopySubZ = floor(canopySubIndex * 0.125);
  let canopySubX = canopySubIndex - canopySubZ * 8.0;
  let canopyNodeSpan = 64.0 * exp2(vertexInputs.terrainNodeA.z);
  let canopyPageLocal = (vec2f(canopySubX, canopySubZ)
    + vec2f(positionUpdated.x, positionUpdated.z)) * canopyNodeSpan;
  let terrainCanopyCover = terrainVertexCanopyClosure(
    vertexInputs.terrainNodeB.z, canopyPageLocal);
  let canopyNyquist = smoothstep(2.0, 4.0, vertexInputs.terrainNodeA.z);
  if (terrainCanopyCover > 0.002 && canopyNyquist > 0.0) {
    let canopyLift = vegetationCanopyLiftMeters(
      terrainCanopyCover,
      distance(worldPos.xyz, scene.vEyePosition.xyz),
      uniforms.terrainCanopyBands,
    );
    worldPos.y = worldPos.y + canopyLift * canopyNyquist;
    vertexOutputs.vPositionW = worldPos.xyz;
  }
}
#endif
`,
  CUSTOM_VERTEX_MAIN_END: /* wgsl */ `
#ifdef TERRAIN_SURFACE_CDLOD
// The x lane is retained for buffer-layout compatibility, but categorical
// fallback ownership moved to the fragment's continuous macro representation.
// Walking the material axis from height here produced kilometre-scale palette
// contours at flight altitude even though it avoided the older per-node plate.
{
  // Lane w is the CHANNEL-atlas lane the fragment addresses page UV with:
  // channelSlot*32 + level, or -1 when the page holds no channel slot. Lane y
  // is -1 for the same reason the page path returns -1: no secondary id is
  // supplied, and 0 would silently mean sand.
  vertexOutputs.terrainSplat = vec4f(
    ${SurfaceMaterial.Grass}.0, -1.0, 0.0, vertexInputs.terrainNodeB.z);
  let subIndexOut = vertexInputs.terrainNodeA.y
    - floor(vertexInputs.terrainNodeA.y * 0.015625) * 64.0;
  let subZOut = floor(subIndexOut * 0.125);
  let subXOut = subIndexOut - subZOut * 8.0;
  // Page-local in METRES, which is what the fragment's page-UV helper
  // divides by the page extent. Emitting it normalised instead made every
  // fragment sample its page's FIRST texel — a per-page constant material,
  // which renders as a flawless uniform desert. The CPU tile path fed metres
  // here and this path has to as well.
  let nodeSpanOut = 64.0 * exp2(vertexInputs.terrainNodeA.z);
  vertexOutputs.terrainPageLocal = (vec2f(subXOut, subZOut)
    + vec2f(positionUpdated.x, positionUpdated.z)) * nodeSpanOut;
}
#else
vertexOutputs.terrainSplat = vertexInputs.color;
vertexOutputs.terrainPageLocal = vertexInputs.position.xz;
#endif
`,
});

/**
 * Exact sparse categorical gather used by the shipping fragment shader and
 * the real-adapter regression oracle. Keeping one WGSL definition prevents a
 * test-only sampler from validating behaviour the renderer does not execute.
 * Return = (primary id, secondary id, secondary share).
 */
export const TERRAIN_SPARSE_SPLAT_GATHER_WGSL = /* wgsl */ `
fn terrainSurfaceSparseSplat(atlasPosition: vec2f, blend: f32) -> vec3f {
  let idScale = f32(${SURFACE_MATERIAL_COUNT - 1});
  let base = vec2i(floor(atlasPosition));
  let fraction = atlasPosition - floor(atlasPosition);
  let offsets = array<vec2i, 4>(
    vec2i(0, 0), vec2i(1, 0), vec2i(0, 1), vec2i(1, 1));
  let cornerWeights = array<f32, 4>(
    (1.0 - fraction.x) * (1.0 - fraction.y),
    fraction.x * (1.0 - fraction.y),
    (1.0 - fraction.x) * fraction.y,
    fraction.x * fraction.y,
  );
  // Keep the ten totals as named scalars. A dynamically indexed private
  // array made this fragment path spill on otherwise-inexpensive adapters;
  // the switch retains the exact corner-major/lane-major addition order.
  var accumulated0 = 0.0;
  var accumulated1 = 0.0;
  var accumulated2 = 0.0;
  var accumulated3 = 0.0;
  var accumulated4 = 0.0;
  var accumulated5 = 0.0;
  var accumulated6 = 0.0;
  var accumulated7 = 0.0;
  var accumulated8 = 0.0;
  var accumulated9 = 0.0;
  for (var cornerIndex = 0u; cornerIndex < 4u; cornerIndex = cornerIndex + 1u) {
    let texel = base + offsets[cornerIndex];
    let ids = textureLoad(terrainSplatId, texel, 0);
    let storedLo = textureLoad(terrainSplatWeightLo, texel, 0);
    let storedHi = textureLoad(terrainSplatWeightHi, texel, 0);
    // 6-8: the ALPHA lane carries canopy closure, not the fourth material
    // weight — which is redundant, because the bake normalises each bucket's
    // top-4 vector. Reconstructing it as the residual is exact up to the
    // other three lanes' 8-bit quantisation, and it makes the vector sum to
    // exactly 1 where the stored one only did approximately.
    let weightLo = vec4f(
      storedLo.xyz, max(0.0, 1.0 - storedLo.x - storedLo.y - storedLo.z));
    let weightHi = vec4f(
      storedHi.xyz, max(0.0, 1.0 - storedHi.x - storedHi.y - storedHi.z));
    let weights = mix(weightLo, weightHi, blend) * cornerWeights[cornerIndex];
    for (var lane = 0u; lane < 4u; lane = lane + 1u) {
      let materialId = u32(clamp(floor(ids[lane] * idScale + 0.5),
        0.0, idScale));
      switch materialId {
        case 0u: { accumulated0 = accumulated0 + weights[lane]; }
        case 1u: { accumulated1 = accumulated1 + weights[lane]; }
        case 2u: { accumulated2 = accumulated2 + weights[lane]; }
        case 3u: { accumulated3 = accumulated3 + weights[lane]; }
        case 4u: { accumulated4 = accumulated4 + weights[lane]; }
        case 5u: { accumulated5 = accumulated5 + weights[lane]; }
        case 6u: { accumulated6 = accumulated6 + weights[lane]; }
        case 7u: { accumulated7 = accumulated7 + weights[lane]; }
        case 8u: { accumulated8 = accumulated8 + weights[lane]; }
        case 9u: { accumulated9 = accumulated9 + weights[lane]; }
        default: {}
      }
    }
  }

  var primaryId = 0u;
  var secondaryId = 0u;
  var primaryWeight = -1.0;
  var secondaryWeight = -1.0;
  var candidateId = 0u;
  var candidateWeight = accumulated0;
  if (candidateWeight > primaryWeight) {
    secondaryId = primaryId;
    secondaryWeight = primaryWeight;
    primaryId = candidateId;
    primaryWeight = candidateWeight;
  } else if (candidateWeight > secondaryWeight) {
    secondaryId = candidateId;
    secondaryWeight = candidateWeight;
  }
  candidateId = 1u;
  candidateWeight = accumulated1;
  if (candidateWeight > primaryWeight) {
    secondaryId = primaryId;
    secondaryWeight = primaryWeight;
    primaryId = candidateId;
    primaryWeight = candidateWeight;
  } else if (candidateWeight > secondaryWeight) {
    secondaryId = candidateId;
    secondaryWeight = candidateWeight;
  }
  candidateId = 2u;
  candidateWeight = accumulated2;
  if (candidateWeight > primaryWeight) {
    secondaryId = primaryId;
    secondaryWeight = primaryWeight;
    primaryId = candidateId;
    primaryWeight = candidateWeight;
  } else if (candidateWeight > secondaryWeight) {
    secondaryId = candidateId;
    secondaryWeight = candidateWeight;
  }
  candidateId = 3u;
  candidateWeight = accumulated3;
  if (candidateWeight > primaryWeight) {
    secondaryId = primaryId;
    secondaryWeight = primaryWeight;
    primaryId = candidateId;
    primaryWeight = candidateWeight;
  } else if (candidateWeight > secondaryWeight) {
    secondaryId = candidateId;
    secondaryWeight = candidateWeight;
  }
  candidateId = 4u;
  candidateWeight = accumulated4;
  if (candidateWeight > primaryWeight) {
    secondaryId = primaryId;
    secondaryWeight = primaryWeight;
    primaryId = candidateId;
    primaryWeight = candidateWeight;
  } else if (candidateWeight > secondaryWeight) {
    secondaryId = candidateId;
    secondaryWeight = candidateWeight;
  }
  candidateId = 5u;
  candidateWeight = accumulated5;
  if (candidateWeight > primaryWeight) {
    secondaryId = primaryId;
    secondaryWeight = primaryWeight;
    primaryId = candidateId;
    primaryWeight = candidateWeight;
  } else if (candidateWeight > secondaryWeight) {
    secondaryId = candidateId;
    secondaryWeight = candidateWeight;
  }
  candidateId = 6u;
  candidateWeight = accumulated6;
  if (candidateWeight > primaryWeight) {
    secondaryId = primaryId;
    secondaryWeight = primaryWeight;
    primaryId = candidateId;
    primaryWeight = candidateWeight;
  } else if (candidateWeight > secondaryWeight) {
    secondaryId = candidateId;
    secondaryWeight = candidateWeight;
  }
  candidateId = 7u;
  candidateWeight = accumulated7;
  if (candidateWeight > primaryWeight) {
    secondaryId = primaryId;
    secondaryWeight = primaryWeight;
    primaryId = candidateId;
    primaryWeight = candidateWeight;
  } else if (candidateWeight > secondaryWeight) {
    secondaryId = candidateId;
    secondaryWeight = candidateWeight;
  }
  candidateId = 8u;
  candidateWeight = accumulated8;
  if (candidateWeight > primaryWeight) {
    secondaryId = primaryId;
    secondaryWeight = primaryWeight;
    primaryId = candidateId;
    primaryWeight = candidateWeight;
  } else if (candidateWeight > secondaryWeight) {
    secondaryId = candidateId;
    secondaryWeight = candidateWeight;
  }
  candidateId = 9u;
  candidateWeight = accumulated9;
  if (candidateWeight > primaryWeight) {
    secondaryId = primaryId;
    secondaryWeight = primaryWeight;
    primaryId = candidateId;
    primaryWeight = candidateWeight;
  } else if (candidateWeight > secondaryWeight) {
    secondaryId = candidateId;
    secondaryWeight = candidateWeight;
  }
  secondaryWeight = max(secondaryWeight, 0.0);
  let secondaryShare = secondaryWeight
    / max(1e-6, max(primaryWeight, 0.0) + secondaryWeight);
  return vec3f(f32(primaryId), f32(secondaryId), secondaryShare);
}
`;

const FRAGMENT_DEFINITIONS = /* wgsl */ `
varying terrainSplat: vec4f;
varying terrainPageLocal: vec2f;
var terrainSurfaceAlbedoSampler: sampler;
var terrainSurfaceAlbedo: texture_2d_array<f32>;
var terrainSurfaceNormalSampler: sampler;
var terrainSurfaceNormal: texture_2d_array<f32>;

struct TerrainSurfaceLayer {
  albedo: vec3f,
  height: f32,
  normal: vec3f,
  roughness: f32,
  cavity: f32,
  f0: f32,
  diffuseRoughness: f32,
};

/** xyz = physical mean linear albedo; w = midpoint roughness. */
fn terrainSurfaceReference(materialIndex: i32) -> vec4f {
${TERRAIN_MATERIAL_REFERENCE_WGSL}
  return vec4f(0.118, 0.183, 0.058, 0.89);
}

fn terrainSurfaceHash(point: vec2f) -> f32 {
  var value = fract(vec3f(point.x, point.y, point.x) * 0.1031);
  value += dot(value, value.yzx + vec3f(33.33));
  return fract((value.x + value.y) * value.z);
}

fn terrainSurfaceValue(point: vec2f) -> f32 {
  let cell = floor(point);
  let local = fract(point);
  let blend = local * local * (vec2f(3.0) - 2.0 * local);
  return mix(
    mix(terrainSurfaceHash(cell), terrainSurfaceHash(cell + vec2f(1.0, 0.0)), blend.x),
    mix(terrainSurfaceHash(cell + vec2f(0.0, 1.0)), terrainSurfaceHash(cell + vec2f(1.0)), blend.x),
    blend.y,
  );
}

fn terrainSurfaceValue2(point: vec2f) -> vec2f {
  return vec2f(terrainSurfaceValue(point), terrainSurfaceValue(point + vec2f(37.7, 19.3)));
}

// Fix-pack T1: value noise with its analytic gradient (w.r.t. the SCALED
// point), for the meso-band normal perturbation. Same lattice and smoothstep
// as terrainSurfaceValue, so the value lane matches it exactly.
fn terrainSurfaceValueGrad(point: vec2f) -> vec3f {
  let cell = floor(point);
  let local = fract(point);
  let blend = local * local * (vec2f(3.0) - 2.0 * local);
  let slope = 6.0 * local * (vec2f(1.0) - local);
  let a = terrainSurfaceHash(cell);
  let b = terrainSurfaceHash(cell + vec2f(1.0, 0.0));
  let c = terrainSurfaceHash(cell + vec2f(0.0, 1.0));
  let d = terrainSurfaceHash(cell + vec2f(1.0));
  return vec3f(
    mix(mix(a, b, blend.x), mix(c, d, blend.x), blend.y),
    mix(b - a, d - c, blend.y) * slope.x,
    mix(c - a, d - b, blend.x) * slope.y,
  );
}

// 3-4 — three decorrelated rotated world scales, each warping the next, each
// faded by the derivative footprint so a scale finer than the pixel stops
// contributing instead of aliasing. Rotations are 13.7 deg and 61.2 deg,
// deliberately NOT the deleted build's 36.3 deg (see the TS constant).
fn terrainSurfaceDetileWarp(worldXz: vec2f, footprint: f32) -> vec2f {
  let amount = uniforms.terrainSurfaceTuning.x;
  if (amount <= 0.0) {
    return vec2f(0.0);
  }
  let macroWeight = 1.0 - smoothstep(15.0, 96.0, footprint);
  let patchWeight = 1.0 - smoothstep(7.0, 64.0, footprint);
  let microWeight = 1.0 - smoothstep(1.5, 20.0, footprint);
  var warp = vec2f(0.0);
  warp += (terrainSurfaceValue2(worldXz * ${(1 / DETILE_MACRO_METERS).toFixed(9)}) - vec2f(0.5))
    * (${DETILE_MACRO_METERS.toFixed(1)} * 0.012 * amount * macroWeight);
  let patchRotation = mat2x2f(${PATCH_COS}, ${PATCH_SIN}, -${PATCH_SIN}, ${PATCH_COS});
  let patchPoint = patchRotation * (worldXz + warp);
  warp += (terrainSurfaceValue2(patchPoint * ${(1 / DETILE_PATCH_METERS).toFixed(9)}) - vec2f(0.5))
    * (${DETILE_PATCH_METERS.toFixed(1)} * 0.05 * amount * patchWeight);
  let microRotation = mat2x2f(${MICRO_COS}, ${MICRO_SIN}, -${MICRO_SIN}, ${MICRO_COS});
  let microPoint = microRotation * (worldXz + warp);
  warp += (terrainSurfaceValue2(microPoint * ${(1 / DETILE_MICRO_METERS).toFixed(9)}) - vec2f(0.5))
    * (${DETILE_MICRO_METERS.toFixed(1)} * 0.10 * amount * microWeight);
  return warp;
}

// The stored pair is the hemisphere projection; z is reconstructed exactly the
// way the CPU Toksvig reducer reconstructs it, so both agree on what "this
// normal" means.
fn terrainSurfaceDecodeNormal(encoded: vec2f) -> vec3f {
  let xy = encoded * 2.0 - vec2f(1.0);
  return vec3f(xy, sqrt(max(0.0, 1.0 - dot(xy, xy))));
}

// Array A stores sqrt(linear albedo) — see SURFACE_ALBEDO_STORAGE_GAMMA. This
// multiply is the pair of the CPU encode.
fn terrainSurfaceDecodeAlbedo(stored: vec3f) -> vec3f {
  return stored * stored;
}

// Reoriented normal mapping. The first argument is the surface normal
// expressed in the projection plane's tangent space (unnormalised — the
// construction does not need it to be); the second is the sampled
// tangent-space normal.
fn terrainSurfaceRnm(base: vec3f, detail: vec3f) -> vec3f {
  let t = base + vec3f(0.0, 0.0, 1.0);
  let u = detail * vec3f(-1.0, -1.0, 1.0);
  return t * (dot(t, u) / max(t.z, 1e-4)) - u;
}

// A tangent orthogonal to the surface normal, chosen from whichever world
// axis that normal is least aligned with.
//
// The obvious normalize(vec3f(1,0,0) - normal * normal.x) is DEGENERATE for
// a normal of (±1, 0, 0) — it normalises the zero vector — and the terrain
// clipmap's crack-guard skirts carry exactly that normal on two of their four
// sides. Every skirt fragment on a non-projected material would have come out
// NaN.
fn terrainSurfaceTangent(normal: vec3f) -> vec3f {
  let axis = select(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 0.0, 1.0), abs(normal.x) > 0.7);
  return normalize(axis - normal * dot(axis, normal));
}

/**
 * Clamp the sampling footprint's ANISOTROPY.
 *
 * Terrain is seen at grazing angles almost all the time — that is what flying
 * is — and a kilometre out the footprint's major axis is a hundred times its
 * minor. The arrays' 16x anisotropicFilteringLevel caps how many taps the
 * hardware will spend on that, and everything past the sixteenth tap is simply
 * not filtered: the result is a regular directional herringbone across the
 * whole ground plane, which is exactly what the first approach-500ft capture
 * after this plugin landed showed, over land and lake alike.
 *
 * Inflating the minor axis until the ratio is within what the sampler will
 * actually spend pushes the chosen mip coarse enough to cover the major axis.
 * It costs sharpness in the minor direction — which is the direction the eye
 * has no resolution in at a grazing angle anyway — and it costs nothing in
 * bandwidth, because the coarser mip is the cheaper fetch.
 */
fn terrainSurfaceLimitAnisotropy(ddx: vec2f, ddy: vec2f) -> mat2x2f {
  let lengthX = max(length(ddx), 1e-8);
  let lengthY = max(length(ddy), 1e-8);
  let major = max(lengthX, lengthY);
  let minimumMinor = major / ${DEFAULT_ANISOTROPY_LIMIT.toFixed(1)};
  let scaleX = max(1.0, minimumMinor / lengthX);
  let scaleY = max(1.0, minimumMinor / lengthY);
  return mat2x2f(ddx * scaleX, ddy * scaleY);
}

// Every sample in this file uses EXPLICIT gradients. House rule since 2-8:
// any sample under a branch or a wrap gets textureSampleGrad, because
// implicit derivatives under branchy blend weights produce hard mip bands
// across slopes.
fn terrainSurfaceFetchAlbedo(layer: i32, uv: vec2f, ddx: vec2f, ddy: vec2f) -> vec4f {
  let limited = terrainSurfaceLimitAnisotropy(ddx, ddy);
  return textureSampleGrad(
    terrainSurfaceAlbedo, terrainSurfaceAlbedoSampler, uv, layer, limited[0], limited[1]);
}

fn terrainSurfaceFetchNormal(layer: i32, uv: vec2f, ddx: vec2f, ddy: vec2f) -> vec4f {
  let limited = terrainSurfaceLimitAnisotropy(ddx, ddy);
  return textureSampleGrad(
    terrainSurfaceNormal, terrainSurfaceNormalSampler, uv, layer, limited[0], limited[1]);
}

fn terrainSurfaceSample(
  materialIndex: i32,
  position: vec3f,
  geometricNormal: vec3f,
  worldDdx: vec3f,
  worldDdy: vec3f,
  detailWeight: f32,
) -> TerrainSurfaceLayer {
  let row = uniforms.terrainMaterialTiling[materialIndex];
  let inversePeriod = row.x;
  let season = uniforms.terrainMaterialSeason[materialIndex];

  var albedoTexel = vec4f(0.5);
  var normalTexel = vec4f(0.5);
  var worldNormal = geometricNormal;

  let slope = 1.0 - clamp(abs(geometricNormal.y), 0.0, 1.0);
  // 3-5: triplanar engages above 1 - |n.y| > 0.22, and only for the materials
  // the 3-0 contract projects (rock and gravel). Everything else is a planar
  // XZ projection, which is what the ground actually is.
#ifdef TERRAIN_SURFACE_PLANAR_ONLY
  // §5.3's Low row: no triplanar at all.
  let projected = false;
#else
  let projected = row.y > 0.5 && slope > ${TRIPLANAR_SLOPE_THRESHOLD.toFixed(2)};
#endif

  if (projected) {
    var weights = pow(abs(geometricNormal), vec3f(4.0));
    weights = weights / max(weights.x + weights.y + weights.z, 1e-4);
#ifndef TERRAIN_SURFACE_TRIPLANAR
    // 2-axis fast path: mandatory from Balanced up (§7 R3), not a High-only
    // optimisation. Fix-pack T8: subtracting the weakest weight from all three
    // zeroes exactly one plane while staying CONTINUOUS as the interpolated
    // normal rotates — the previous hard drop switched the retained pair at a
    // C0 edge, drawing lines along ridges where the ordering flips. The
    // weakest plane's weight is exactly zero, so its fetches stay skipped.
    let weakest = min(weights.x, min(weights.y, weights.z));
    weights = weights - vec3f(weakest);
    let weightSum = weights.x + weights.y + weights.z;
    // All three pow-4 weights equal (|n| along the body diagonal) zeroes the
    // subtraction outright; 1e-4 division noise then normalizes a zero
    // blended normal into NaN. Equal thirds is the correct limit there.
    if (weightSum <= 1e-4) {
      weights = vec3f(1.0 / 3.0);
    } else {
      weights = weights / weightSum;
    }
#endif
    // Sign-flipped per-plane UVs. Untreated, the projection mirrors across
    // each axis and produces a visible reflection seam down every ridge.
    let signs = sign(geometricNormal + vec3f(1e-6));
    let uvX = vec2f(position.z * signs.x, position.y) * inversePeriod;
    let uvY = vec2f(position.x * signs.y, position.z) * inversePeriod;
    let uvZ = vec2f(-position.x * signs.z, position.y) * inversePeriod;
    let ddxX = vec2f(worldDdx.z * signs.x, worldDdx.y) * inversePeriod;
    let ddyX = vec2f(worldDdy.z * signs.x, worldDdy.y) * inversePeriod;
    let ddxY = vec2f(worldDdx.x * signs.y, worldDdx.z) * inversePeriod;
    let ddyY = vec2f(worldDdy.x * signs.y, worldDdy.z) * inversePeriod;
    let ddxZ = vec2f(-worldDdx.x * signs.z, worldDdx.y) * inversePeriod;
    let ddyZ = vec2f(-worldDdy.x * signs.z, worldDdy.y) * inversePeriod;

    let absNormal = abs(geometricNormal);
    var albedoSum = vec4f(0.0);
    var normalSum = vec4f(0.0);
    var blended = vec3f(0.0);
    // The tangent normal's U axis is flipped by the SAME sign the UV was, or
    // the detail is mirrored against the pattern it belongs to; the blended
    // result's own plane axis is flipped again to put it back in world space.
    // Omitting either half is a normal pointing the wrong way on one side of
    // every ridge — the seam the sign-flipped UVs exist to prevent, moved out
    // of albedo and into lighting where it is harder to see and just as wrong.
    if (weights.x > 0.001) {
      let a = terrainSurfaceFetchAlbedo(materialIndex, uvX, ddxX, ddyX);
      let b = terrainSurfaceFetchNormal(materialIndex, uvX, ddxX, ddyX);
      albedoSum += a * weights.x;
      normalSum += b * weights.x;
      let sampled = terrainSurfaceDecodeNormal(b.xy);
      let tangentNormal = terrainSurfaceRnm(
        vec3f(geometricNormal.zy, absNormal.x),
        vec3f(sampled.x * signs.x * detailWeight, sampled.y * detailWeight, sampled.z),
      );
      blended += vec3f(tangentNormal.z * signs.x, tangentNormal.y, tangentNormal.x) * weights.x;
    }
    if (weights.y > 0.001) {
      let a = terrainSurfaceFetchAlbedo(materialIndex, uvY, ddxY, ddyY);
      let b = terrainSurfaceFetchNormal(materialIndex, uvY, ddxY, ddyY);
      albedoSum += a * weights.y;
      normalSum += b * weights.y;
      let sampled = terrainSurfaceDecodeNormal(b.xy);
      let tangentNormal = terrainSurfaceRnm(
        vec3f(geometricNormal.xz, absNormal.y),
        vec3f(sampled.x * signs.y * detailWeight, sampled.y * detailWeight, sampled.z),
      );
      blended += vec3f(tangentNormal.x, tangentNormal.z * signs.y, tangentNormal.y) * weights.y;
    }
    if (weights.z > 0.001) {
      let a = terrainSurfaceFetchAlbedo(materialIndex, uvZ, ddxZ, ddyZ);
      let b = terrainSurfaceFetchNormal(materialIndex, uvZ, ddxZ, ddyZ);
      albedoSum += a * weights.z;
      normalSum += b * weights.z;
      let sampled = terrainSurfaceDecodeNormal(b.xy);
      let tangentNormal = terrainSurfaceRnm(
        vec3f(geometricNormal.xy, absNormal.z),
        vec3f(sampled.x * -signs.z * detailWeight, sampled.y * detailWeight, sampled.z),
      );
      blended += vec3f(tangentNormal.x, tangentNormal.y, tangentNormal.z * signs.z) * weights.z;
    }
    albedoTexel = albedoSum;
    normalTexel = normalSum;
    worldNormal = normalize(blended);
  } else {
#ifdef TERRAIN_SURFACE_PLANAR_ONLY
    // Tier 0: no triplanar at all. A slope-stretched planar projection is the
    // cheap approximation — shorten the period as the face tilts so a cliff is
    // not an infinitely smeared top-down sample.
    let stretch = 1.0 / clamp(abs(geometricNormal.y), 0.35, 1.0);
#else
    let stretch = 1.0;
#endif
    let uv = position.xz * (inversePeriod * stretch);
    let ddx = worldDdx.xz * (inversePeriod * stretch);
    let ddy = worldDdy.xz * (inversePeriod * stretch);
    albedoTexel = terrainSurfaceFetchAlbedo(materialIndex, uv, ddx, ddy);
    normalTexel = terrainSurfaceFetchNormal(materialIndex, uv, ddx, ddy);
    // C4: the tangent frame is the one implied by the planar XZ projection —
    // analytic and free. No vertex tangent attribute exists.
    let tangentNormal = terrainSurfaceDecodeNormal(normalTexel.xy);
    let tangent = terrainSurfaceTangent(geometricNormal);
    let bitangent = cross(tangent, geometricNormal);
    // Fix-pack T8: the 0.15 floor amplified stored slopes up to 6.7×, which on
    // already-steep geometry pushed the composed normal past the horizon —
    // black texels along every synthesized crack/joint line. 0.32 caps the
    // amplification at ~3×; the hemisphere clamp at composition is the second
    // half of the fix.
    let rise = 1.0 / max(tangentNormal.z, 0.32);
    worldNormal = normalize(
      geometricNormal
      + tangent * (tangentNormal.x * rise * detailWeight)
      + bitangent * (tangentNormal.y * rise * detailWeight)
    );
  }

  var layer: TerrainSurfaceLayer;
  let reference = terrainSurfaceReference(materialIndex);
  // Once microstructure is smaller than a pixel, converge EVERY patterned
  // channel to its physical mean. Fading only the normal left albedo joints,
  // height and cavity repeating through coarse mips; biplanar Rock then
  // crossed those residual combs into the reported screen-door mountain.
  layer.albedo = mix(
    reference.rgb,
    terrainSurfaceDecodeAlbedo(albedoTexel.rgb),
    detailWeight,
  ) * season.rgb;
  layer.height = mix(0.5, albedoTexel.a, detailWeight);
  layer.normal = worldNormal;
  layer.roughness = clamp(mix(reference.w, normalTexel.b, detailWeight) + season.a, 0.02, 1.0);
  layer.cavity = mix(1.0, normalTexel.a, detailWeight);
  layer.f0 = row.z;
  layer.diffuseRoughness = row.w;
  return layer;
}

// ---------------------------------------------------------------------------
// 6-5's WETNESS FIELD, WGSL half. See the TypeScript twins above for the
// derivation, the three sources and the not-seasonal decision.
//
// 6-2's block is composed here rather than restated. It declares no uniform,
// samples no texture and takes no derivative, which is the property that lets
// it cross from the water lattice into a terrain shader unchanged; every
// function it defines carries a water- prefix, so the R-3F collision rule is
// satisfied the same way 6-8's vegetationCanopyHandoff satisfies it.
//
// UNCONDITIONAL, not behind the hydrology define: the ocean half of this field
// is driven by sea level and a published sea state, both of which exist in an
// analytic world. Only the lake/bank half needs a page channel.
// ---------------------------------------------------------------------------
${WATER_SHORE_RUNUP_WGSL}

// tan(beta) from the terrain's OWN geometric normal at full resolution — never
// re-derived from the 16 m bathymetry, which is the resolution floor 6-2's
// shore band had to go wide to hide.
fn terrainSurfaceBeachSlope(normalY: f32) -> f32 {
  let ny = max(normalY, ${terrainWgslFloat(TERRAIN_WETNESS_MINIMUM_NORMAL_Y)});
  return sqrt(max(0.0, 1.0 - ny * ny)) / ny;
}

// Source 3: the capillary fringe over a waterline. Saturated at the waterline,
// dry at the top of the fringe, continuous through zero so it joins the
// submerged term without a seam. Written as 1 - smoothstep(low, high) — never
// as a reversed pair, which the clamped form turns into a hard step.
fn terrainSurfaceCapillaryWetness(heightAboveWaterMeters: f32) -> f32 {
  return 1.0 - smoothstep(
    0.0,
    ${terrainWgslFloat(TERRAIN_WETNESS_CAPILLARY_RISE_METERS)},
    heightAboveWaterMeters);
}

// Source 1's bank half: the signed shore distance converted to a freeboard by
// the terrain's own gradient, through Hunt's own slope clamps. Inside the water
// the product is negative and the fringe reads 1, so the band crosses the
// waterline continuously instead of starting at it.
fn terrainSurfaceBankWetness(shoreDistanceMeters: f32, beachSlope: f32) -> f32 {
  let slope = clamp(
    beachSlope,
    WATER_RUNUP_BEACH_SLOPE_MINIMUM,
    WATER_RUNUP_BEACH_SLOPE_MAXIMUM);
  return terrainSurfaceCapillaryWetness(shoreDistanceMeters * slope);
}

// The OCEAN half of the field: 6-2's run-up persistence and the capillary band
// above still water, from the freeboard this fragment already forms. Returns
// exactly 0 for a glassy sea beyond the fringe, so an analytic world with no
// published swell keeps the sea-level band alone with no branch of its own.
fn terrainSurfaceShoreWetness(
  freeboardMeters: f32,
  beachSlope: f32,
  excursionMeters: f32,
  radianFrequency: f32,
  runupClockSeconds: f32,
) -> f32 {
  // The EXACT early-out, and the reason the whole term costs an inland
  // fragment one compare. waterShoreWetness's exceedance factor is identically
  // zero past 1.35 R; R = clamp(slope) * excursion can never exceed
  // 0.35 * excursion because Hunt's slope clamp caps it; and the capillary
  // fringe is identically zero past its own rise. Above the larger of the two
  // this function cannot return anything but zero, for ANY slope — so this
  // skips an asin, an exp, a sin and a divide without changing a pixel.
  let reach = max(
    ${terrainWgslFloat(TERRAIN_WETNESS_CAPILLARY_RISE_METERS)},
    max(excursionMeters, 0.0)
      * WATER_RUNUP_BEACH_SLOPE_MAXIMUM * WATER_RUNUP_EXCEEDANCE);
  if (freeboardMeters > reach) { return 0.0; }
  let swell = WaterShoreSwell(0.0, 1.0, radianFrequency, max(excursionMeters, 0.0));
  let swashHeight = waterShoreRunupHeight(swell, beachSlope);
  // Above the waterline the still-water depth is negative, the eikonal's
  // travel time clamps to zero, and the whole swash zone beats together: a
  // bore that has crossed the waterline is one sheet, not a train.
  let phase = waterShoreRunupPhase(
    -freeboardMeters, beachSlope, radianFrequency, runupClockSeconds);
  let swash = waterShoreWetness(freeboardMeters, swashHeight, phase, radianFrequency);
  return max(swash, terrainSurfaceCapillaryWetness(freeboardMeters));
}

// ---------------------------------------------------------------------------
// 4-7's channel pages, consumed on the CPU TILE MESHES.
//
// This is what makes Gate 4B visible one gate before the quadtree exists: the
// occlusion bake writes into channel pages, and their consumer is THIS
// fragment shader, addressed through 3-2's reserved atlasSlot lane. The
// whole block compiles out when no channel atlas is bound.
// ---------------------------------------------------------------------------
#ifdef TERRAIN_SURFACE_PAGE_CHANNELS
var terrainOcclusionAtlasSampler: sampler;
var terrainOcclusionAtlas: texture_2d<f32>;
var terrainHorizonAtlasASampler: sampler;
var terrainHorizonAtlasA: texture_2d<f32>;
var terrainHorizonAtlasBSampler: sampler;
var terrainHorizonAtlasB: texture_2d<f32>;
var terrainSplatIdSampler: sampler;
var terrainSplatId: texture_2d<f32>;
var terrainSplatWeightLoSampler: sampler;
var terrainSplatWeightLo: texture_2d<f32>;
var terrainSplatWeightHiSampler: sampler;
var terrainSplatWeightHi: texture_2d<f32>;

#ifdef TERRAIN_SURFACE_HYDROLOGY_CHANNELS
// 6-6: the signed shore-distance channel, r16sint, addressed by textureLoad.
//
// An INTEGER texture takes no sampler binding, so this costs one sampled-texture
// slot and no sampler slot — the plugin goes from 8 fragment textures to 9
// against WebGPU's 16-per-stage base limit, leaving 6-5 and 6-8 the room the
// section 1.2 count reserved.
//
// It is declared behind its own define rather than behind the zero sentinel
// alone: an analytic world has no hydrology at all, so compiling the binding,
// the load and the ALU out of the shipping default makes the parity guarantee
// COST-dark as well as pixel-dark. The page guard below still runs inside an
// eroded world, where a page can be geometry-resident before its aux upload.
var terrainShoreDistanceAtlas: texture_2d<i32>;

// The riparian bank band at this fragment, on the density field's own corridor
// shape. Zero away from water, zero over water (the submerged term owns that),
// zero on any page without a channel slot.
fn terrainSurfaceRiparianBand(uv: vec4f) -> f32 {
  if (uv.z <= 0.0) { return 0.0; }
  let texel = vec2i(floor(uv.xy * uniforms.terrainPageAtlas.x));
  let distanceMeters = f32(textureLoad(terrainShoreDistanceAtlas, texel, 0).r)
    * ${TERRAIN_PAGE_HYDROLOGY_ENCODING.shoreDistanceMetersPerUnit};
  if (distanceMeters <= 0.0) { return 0.0; }
  return smoothstep(
      ${RIPARIAN_BANK_NEAR_METERS.toFixed(2)},
      ${RIPARIAN_BANK_FULL_METERS.toFixed(2)},
      distanceMeters)
    * (1.0 - smoothstep(
      ${RIPARIAN_BANK_FADE_START_METERS.toFixed(2)},
      ${RIPARIAN_BANK_FADE_END_METERS.toFixed(2)},
      distanceMeters));
}

// 6-5: the lake-depth channel — C-9's last dark row, and its first named
// consumer in the project's history. r16float in METRES of water column, read
// by textureLoad with NO companion sampler declared, so it costs one
// sampled-texture slot and zero sampler slots. The fragment goes from 9 sampled
// textures to 10 against WebGPU's 16-per-stage base limit and stays at 8
// samplers; the shipping ANALYTIC build compiles neither, so its count is
// unchanged at 8 textures / 8 samplers.
var terrainLakeDepthAtlas: texture_2d<f32>;

// (submerged fraction, bank wetness) at this fragment.
//
// x is the lake's OWN submerged term: lakeDepth is metres of water column
// over this texel, so a lake at 400 m elevation finally reads as a wet bed
// instead of the dry SAND the WATER biome's primary material paints — the case
// the sea-level term structurally cannot answer, because (seaLevel - y) is
// hugely negative up there.
//
// y is the bank fringe, from the SAME wet mask: terrainSignedShoreDistance
// signs its transform on lakeDepth > 0, so the two channels share one
// waterline by construction and the fringe joins the bed without a seam.
// Zero on any page without a channel slot, which is the co-residency rule.
fn terrainSurfaceLakeWetness(uv: vec4f, beachSlope: f32) -> vec2f {
  if (uv.z <= 0.0) { return vec2f(0.0, 0.0); }
  let texel = vec2i(floor(uv.xy * uniforms.terrainPageAtlas.x));
  let depthMeters = textureLoad(terrainLakeDepthAtlas, texel, 0).r;
  let distanceMeters = f32(textureLoad(terrainShoreDistanceAtlas, texel, 0).r)
    * ${TERRAIN_PAGE_HYDROLOGY_ENCODING.shoreDistanceMetersPerUnit};
  return vec2f(
    clamp(
      depthMeters / ${terrainWgslFloat(TERRAIN_WETNESS_LAKE_SUBMERGED_DEPTH_METERS)},
      0.0,
      1.0),
    terrainSurfaceBankWetness(distanceMeters, beachSlope),
  );
}
#endif

${TERRAIN_SPARSE_SPLAT_GATHER_WGSL}
${VEGETATION_CANOPY_HANDOFF_WGSL}

/**
 * 6-8: canopy closure at this fragment, from the weight atlas's alpha lane.
 *
 * A SINGLE bilinear tap, not the sparse gather's twelve loads, and it is read
 * at EVERY level rather than behind the page-splat confidence gate. That is
 * the difference between a categorical channel and a continuous one: filtering
 * two material ids together manufactures a material neither texel chose, but
 * filtering two closures together is what closure means. The gate exists to
 * stop a coarse texel inventing a categorical patch; closure has no such
 * failure mode, and the far handoff needs it exactly where the gate closes.
 *
 * A 1-texel bilinear footprint cannot cross a slot: the page-UV helper clamps
 * page-local into [0, 1] and the bake writes the full gutter.
 */
fn terrainSurfaceCanopyClosure(uv: vec4f) -> f32 {
  if (uv.z <= 0.0) { return 0.0; }
  return clamp(
    textureSampleLevel(
      terrainSplatWeightLo, terrainSplatWeightLoSampler, uv.xy, 0.0).a,
    0.0,
    1.0);
}

/**
 * Sparse bilinear page splat. Material identifiers are categorical data: a
 * filtered texture fetch would manufacture ids that none of the four texels
 * selected. Load all four neighbours exactly, accumulate their four sparse
 * weights by id, then choose the strongest two real materials. Season blends
 * weights over the per-texel shared low/high material basis baked into the id
 * atlas, so every weight lane names the same material in both season buckets.
 *
 * Return = (primary id, secondary id, secondary share, page confidence).
 */
fn terrainSurfacePageSplat(uv: vec4f, blend: f32) -> vec4f {
  let channelTexelMeters = uniforms.terrainPageAtlasGrid.y * exp2(uv.w)
    / uniforms.terrainPageAtlas.z;
  let confidence = clamp(
    1.0
      - (log2(max(channelTexelMeters, ${TERRAIN_PAGE_SPLAT_FINEST_TEXEL_METERS.toFixed(1)}))
        - ${Math.log2(TERRAIN_PAGE_SPLAT_FINEST_TEXEL_METERS).toFixed(1)})
        * ${TERRAIN_PAGE_SPLAT_CONFIDENCE_LOSS_PER_LEVEL.toFixed(1)},
    0.0,
    1.0);
  // Coarse/unresident pages use the provisional axis. Return before twelve
  // sparse texture loads so the visual safety fallback also reduces cost.
  if (confidence < ${TERRAIN_PAGE_SPLAT_MINIMUM_CONFIDENCE.toFixed(1)} || uv.z <= 0.0) {
    return vec4f(0.0, 0.0, 0.0, 0.0);
  }
  let atlasPosition = uv.xy * uniforms.terrainPageAtlas.x - vec2f(0.5);
  let sparse = terrainSurfaceSparseSplat(atlasPosition, blend);
  return vec4f(sparse, confidence * uv.z);
}

/**
 * Atlas UV for this fragment's page, or w = 0 when the page holds no channel
 * slot — the CO-RESIDENCY RULE: a mesh samples channel pages only while its
 * page is resident, and otherwise falls back to the Phase 3 provisional path.
 *
 * The lane packs slotIndex * 32 + level, because the fragment needs the
 * page EXTENT to normalise its local position and a shared material cannot
 * carry a per-mesh uniform.
 */
fn terrainSurfacePageUv(lane: f32, pageLocal: vec2f) -> vec4f {
  if (lane < 0.0) { return vec4f(0.0, 0.0, 0.0, 0.0); }
  let slot = floor(lane * ${1 / 32});
  let level = lane - slot * 32.0;
  let extent = uniforms.terrainPageAtlasGrid.y * exp2(level);
  let grid = uniforms.terrainPageAtlasGrid.x;
  let row = floor(slot / grid);
  let slotOrigin = vec2f(slot - row * grid, row) * uniforms.terrainPageAtlas.y;
  let core = uniforms.terrainPageAtlas.z;
  let inPage = clamp(pageLocal / extent, vec2f(0.0), vec2f(1.0));
  let texel = slotOrigin + vec2f(uniforms.terrainPageAtlas.w) + inPage * core;
  return vec4f(texel / uniforms.terrainPageAtlas.x, 1.0, level);
}

${HORIZON_FIELD_LOOKUP_WGSL}

/**
 * Sun visibility from the 8-azimuth horizon map.
 *
 * '6-11': the arithmetic moved to 'HorizonField''s 'horizonFieldShadow', which
 * far vegetation composes too — two representations of the same stand must not
 * disagree about whether the sun is up. What stays here is what is genuinely
 * this consumer's: the page-atlas FETCH through 3-2's slot lane, the residency
 * fallback, and the band width.
 *
 * Fix-pack T8's band and jitter are unchanged: the soft band is floored at
 * ~1.7° and the compared elevation carries a per-fragment spatial jitter,
 * because the narrow fixed band drew the coarse horizon field's iso-contours
 * as stripes on close slopes at low sun.
 */
fn terrainSurfaceHorizonShadow(uv: vec4f, sunDirection: vec3f, jitter: f32) -> f32 {
  if (uv.z <= 0.0) { return 1.0; }
  let packedA = textureSampleLevel(terrainHorizonAtlasA, terrainHorizonAtlasASampler, uv.xy, 0.0);
  let packedB = textureSampleLevel(terrainHorizonAtlasB, terrainHorizonAtlasBSampler, uv.xy, 0.0);
  let band = max(uniforms.terrainPageAtlasGrid.w, 0.03);
  return horizonFieldShadow(packedA, packedB, sunDirection, band, jitter);
}
#endif
`;

const FRAGMENT_BEFORE_LIGHTS = /* wgsl */ `
let terrainAbsolutePosition = vec3f(
  fragmentInputs.vPositionW.x + uniforms.terrainWorldOrigin.x,
  fragmentInputs.vPositionW.y,
  fragmentInputs.vPositionW.z + uniforms.terrainWorldOrigin.y,
);
// Derivatives are taken ONCE, in uniform control flow, before any branch —
// every sample below is textureSampleGrad against these.
let terrainWorldDdx = dpdx(terrainAbsolutePosition);
let terrainWorldDdy = dpdy(terrainAbsolutePosition);
// 3-3 defect 1: the footprint, not a camera-distance gate. The superseded
// plugin faded micro-detail out over a fixed 1.2-4.2 km band of CAMERA
// DISTANCE, which switched it OFF at exactly the range where the audit
// measures vertex normals to be worst and slid the detail ring across the
// ground with the aircraft. A derivative footprint stays attached to the
// surface.
let terrainFootprintMajor = max(length(terrainWorldDdx.xz), length(terrainWorldDdy.xz));
let terrainFootprintMinor = min(length(terrainWorldDdx.xz), length(terrainWorldDdy.xz));
// Fix-pack T2: fade on the footprint the 16× anisotropic sampler actually
// resolves — the minor axis, floored at major/16 — not the raw major axis.
// At flight grazing angles the major axis crosses any threshold within a few
// hundred metres while the minor axis (the direction the eye resolves) stays
// small for kilometres; keying on the major axis was the single largest term
// in the reported clay-smooth ground.
let terrainFootprint = max(
  terrainFootprintMinor,
  terrainFootprintMajor * ${(1 / 16).toFixed(6)},
);
let terrainDetailWeight = 1.0 - smoothstep(
  ${TERRAIN_MATERIAL_DETAIL_FULL_FOOTPRINT_METERS.toFixed(2)},
  ${TERRAIN_MATERIAL_DETAIL_ZERO_FOOTPRINT_METERS.toFixed(2)},
  terrainFootprint,
);

// CDLOD's vertex stage derives a smooth macro normal from the same fine/parent
// height samples and morph used for displacement. Babylon inverse-transforms
// and interpolates it into normalW. A screen-derivative cross here is constant
// over each rasterized triangle; using it turned the 33x33 LOD grid into the
// reported plates of colour through lighting, slope cover and triplanar mode.
let terrainGeometricNormal = normalize(normalW);
let terrainSlope = 1.0 - clamp(abs(terrainGeometricNormal.y), 0.0, 1.0);

// 3-4: one warped position feeds every projection, so the de-tiling cannot
// disagree between planes.
// The de-tile warp keeps the MAJOR-axis footprint its per-scale fades were
// tuned against — T2's anisotropy-limited footprint belongs to the material
// detail fade only, and feeding it here re-engaged the 28 m micro warp far
// past its own Nyquist at grazing angles.
let terrainWarp = terrainSurfaceDetileWarp(terrainAbsolutePosition.xz, terrainFootprintMajor);
// The macro and patch scales also carry the world-scale brightness variation
// the layers themselves no longer do: 3-1 high-passes each material so its
// tiling period cannot show at range, which leaves the hundred-metre and
// kilometre structure to be put back HERE, where it does not repeat. The
// figures are the deleted build's — a camera-stable macro wash it had and the
// audit was right to want back.
let terrainMacroNoiseA = terrainSurfaceValue(
  terrainAbsolutePosition.xz * ${(1 / DETILE_MACRO_METERS).toFixed(9)} + vec2f(11.3, 5.9));
let terrainMacroNoiseB = terrainSurfaceValue(
  terrainAbsolutePosition.xz * ${(1 / DETILE_PATCH_METERS).toFixed(9)} + vec2f(3.1, 27.5));
let terrainMacroVariation = mix(0.84, 1.18, terrainMacroNoiseA)
  * mix(0.93, 1.09, terrainMacroNoiseB);
// Wave Q (plastic-ground fix): the wash was a pure SCALAR, so distant ground
// converged to one hue under a brightness ramp — no visible texture. Tie a
// chromatic swing to the same noises: bright patches read sun-bleached and
// dry (warm), dark patches read lush/damp (cool) — the correlation real
// ground has. Runway paint is applied after this and stays unstained.
let terrainMacroHue = mix(vec3f(0.952, 1.0, 1.058), vec3f(1.052, 1.004, 0.934), terrainMacroNoiseA)
  * mix(vec3f(0.976, 1.0, 1.026), vec3f(1.026, 1.002, 0.974), terrainMacroNoiseB);
// Wave Q (reptile-mountain fix): the de-tile warp was horizontal-only, but
// the two cliff-dominant triplanar planes use world Y as their V axis — so
// the Rock tile repeated in EXACT register every 5.9 m of altitude across
// whole mountainsides, turning its band families into a wallpaper lattice.
// One low-frequency vertical octave (±7 m over ~183 m) breaks the
// registration; its slope stays far below the horizontal warps' fades.
// Wave R: a second, finer octave — the single 183 m octave is effectively
// constant across a 30 m cliff view, so the 5.9 m V-axis tile repeat still
// stood in exact register at close range.
let terrainWarpVertical = (terrainSurfaceValue(
  terrainAbsolutePosition.xz * ${(1 / 183).toFixed(9)} + vec2f(43.7, 17.3)) - 0.5) * 14.0
  + (terrainSurfaceValue(
    terrainAbsolutePosition.xz * ${(1 / 31).toFixed(9)} + vec2f(9.1, 77.3)) - 0.5) * 3.6;
let terrainSamplePosition = vec3f(
  terrainAbsolutePosition.x + terrainWarp.x,
  terrainAbsolutePosition.y + terrainWarpVertical,
  terrainAbsolutePosition.z + terrainWarp.y,
);

#ifdef TERRAIN_SURFACE_PAGE_CHANNELS
let terrainPageUv = terrainSurfacePageUv(
  fragmentInputs.terrainSplat.w,
  fragmentInputs.terrainPageLocal,
);
// textureSampleLevel, not textureSample: the house rule since 2-8 is that no
// sample under a branch or a wrap takes implicit derivatives, and the channel
// atlas carries no mip chain — level 0 is the only correct level, and mip
// selection across atlas slots would bleed neighbouring pages into each other.
let terrainOcclusionTexel = textureSampleLevel(
  terrainOcclusionAtlas, terrainOcclusionAtlasSampler, terrainPageUv.xy, 0.0);
// r is baked sky visibility; a fully unbaked page reads 0, so the fallback
// keeps it at 1 rather than plunging the ground into darkness.
let terrainSkyVisibility = mix(1.0, terrainOcclusionTexel.r, terrainPageUv.z);
let terrainHorizonShadow = terrainSurfaceHorizonShadow(
  terrainPageUv, uniforms.terrainSunDirection.xyz,
  terrainSurfaceHash(terrainAbsolutePosition.xz * 0.37));
// 4-6: the real classifier's output replaces the provisional lanes wherever a
// channel page is resident. Where one is not, the co-residency rule applies
// and the Phase 3 provisional splat is what the fragment gets.
let terrainPageSplat = terrainSurfacePageSplat(
  terrainPageUv, uniforms.terrainSunDirection.w);
#else
let terrainSkyVisibility = 1.0;
let terrainHorizonShadow = 1.0;
#endif

// Fine L0 channel pages own categorical material identity. A coarser page's
// classifier texel spans 8..256 m and cannot safely invent a categorical
// patch, while the old emergency altitude walk painted kilometre-wide
// Grass→Floor→Shrub→Rock colour lobes. The no-page representation therefore
// starts from one continuous Grass base. Geometric slope, a perturbed alpine
// driver and seasonal snow add resolved macro cover through the existing third
// candidate below; material microstructure independently fades by footprint.
var terrainAxis = ${SurfaceMaterial.Grass}.0;
var terrainLowerId = ${SurfaceMaterial.Grass}.0;
var terrainUpperId = ${SurfaceMaterial.Grass}.0;
var terrainAxisFraction = 0.0;
#ifdef TERRAIN_SURFACE_PAGE_CHANNELS
// Never interpolate categorical ids. At the native 4 m channel footprint the
// sparse gather supplies two real ids and their filtered weights. Coarser
// geometry pages have zero classification confidence and keep the continuous
// macro fallback instead of painting 8..256 m single-material plates.
let terrainUsePageSplat = terrainPageSplat.w >= ${TERRAIN_PAGE_SPLAT_MINIMUM_CONFIDENCE.toFixed(1)};
if (terrainUsePageSplat) {
  terrainAxis = terrainPageSplat.x;
  terrainLowerId = terrainPageSplat.x;
  terrainUpperId = terrainPageSplat.y;
  terrainAxisFraction = terrainPageSplat.z;
}
#else
let terrainUsePageSplat = false;
#endif

// The third candidate is FRAGMENT-DERIVED ONLY.
//
// The provisional splat's lanes y and z carry a secondary cover and its weight,
// but this shader does not read them because a secondary id cannot survive
// vertex interpolation. Bracketing it
// would blend two materials that never meet (the secondaries of climatic
// neighbours are not adjacent on the ecotone axis, and cannot all be made so
// without implausible companions), and ROUNDING it paints every intermediate
// id at full weight: a grassland/forest boundary lays a band of snow and a
// band of rock along itself, because 6 sweeps to 3 through 5 and 4. A
// "confidence" gate fading the weight at half-integers does not help — the
// intermediate ids are hit AT the integers, where such a gate is wide open.
//
// Resident fine page splats restore their real secondary through the sparse
// gather above. The third candidate is the mutually exclusive residual of the
// fragment's slope-exposed/alpine rock and seasonal snow blanket. Both are
// evaluated HERE rather than per vertex, which is the one place this fallback
// is strictly better than a coarse categorical page: a cliff gets rock at
// fragment resolution instead of in an 8..256 m block.
let terrainCoverNoise =
    (terrainSurfaceValue(terrainAbsolutePosition.xz * (1.0 / 430.0)) - 0.5) * 78.0
  + (terrainSurfaceValue(terrainAbsolutePosition.xz * (1.0 / 95.0)) - 0.5) * 19.0;
let terrainElevationDriver = terrainAbsolutePosition.y
  - uniforms.terrainSurfaceWetness.y + terrainCoverNoise;
// Wave Q: how much this fragment trusts the page classification over the
// provisional fallback. Confidence loses a fifth per residency level, and
// the cover noise mottles the threshold by ~±0.14, so every level border
// dissolves into ecotone-scale patches instead of a straight page edge.
// The curve saturates by w ≈ 0.85, so fine pages never pay the feather.
#ifdef TERRAIN_SURFACE_PAGE_CHANNELS
let terrainClassStrength = smoothstep(
  0.05, 0.85, terrainPageSplat.w + terrainCoverNoise * 0.003);
#else
let terrainClassStrength = 0.0;
#endif
let terrainClassComplement = 1.0 - terrainClassStrength;
// Wave R: the fragment-derived slope rock also carries the class
// complement — unscaled, a slope-0.66 face was 100% this override even on a
// trusted level-0 page, erasing the classifier's Snow/Shrub/Gravel from
// every close mountainside (the close-range mountain was nothing but the
// Rock recipe). The classifier owns steep ground where it is trusted; this
// term is the fallback's cliff answer, exactly like the alpine term below.
var terrainSlopeRock = smoothstep(0.30, 0.66, terrainSlope) * terrainClassComplement;
// This is the altitude term from the real classifier, kept deliberately
// weaker than a true cliff. It greys alpine fallback terrain continuously
// without walking through four categorical material palettes. Wave Q: it
// scales by the CLASS COMPLEMENT instead of a binary no-splat gate, so its
// onset tracks the same feather that hands classification back to the
// fallback — one continuous ecotone, no page-edge switch.
terrainSlopeRock = max(
  terrainSlopeRock,
  smoothstep(
    ${TERRAIN_FALLBACK_ALPINE_START_METERS.toFixed(1)},
    ${TERRAIN_FALLBACK_ALPINE_END_METERS.toFixed(1)},
    terrainElevationDriver,
  ) * ${TERRAIN_FALLBACK_ALPINE_ROCK_STRENGTH.toFixed(2)} * terrainClassComplement,
);


// 3-10's SEASONAL snow blanket. Two properties, both learned the hard way from
// the first capture after this plugin landed:
//
//  - On a trusted L0 page it is ZERO at the reference day: that classifier
//    already puts Snow above the reference snowline. The coarse/no-page macro
//    representation has no classifier, so it supplies that reference blanket
//    itself before adding the seasonal descent.
//  - Its driver is PERTURBED, not its output. An unperturbed elevation band is
//    an iso-contour, and iso-contours on a mountain are closed white rings —
//    which is exactly what the first capture showed. RENDERING_PLAN.md §3.2
//    states the rule for 4-6's classifier ("perturb the drivers, not the
//    outputs"); it applies just as much to one band.
let terrainSnowline = uniforms.terrainSurfaceTuning.w;
let terrainSnowDescent = max(0.0, uniforms.terrainSurfaceWetness.z - terrainSnowline);
let terrainSnowDriver = terrainElevationDriver + uniforms.terrainSurfaceWetness.y;
// Steep faces shed snow — the 2-18 slope-weighting rule, applied to the
// ground the same way it is applied to canopy and rock.
let terrainSnowShed = 1.0 - clamp((terrainSlope - 0.5) * 1.7, 0.0, 1.0);
// Wave Q: the reference blanket carries the class complement for the same
// reason as the alpine term above — a trusted classifier already placed
// Snow, so the macro blanket fades in exactly as classification fades out.
var terrainSnowCover = smoothstep(
  uniforms.terrainSurfaceWetness.z - 120.0,
  uniforms.terrainSurfaceWetness.z + 120.0,
  terrainSnowDriver,
) * terrainSnowShed * terrainClassComplement;
if (terrainSnowDescent > 1.0) {
  let terrainSnowBand = smoothstep(terrainSnowline - 120.0, terrainSnowline + 120.0,
    terrainSnowDriver);
  // Fade the blanket in with the descent itself, so the first cold week does
  // not switch a hillside white.
  terrainSnowCover = max(
    terrainSnowCover,
    terrainSnowBand * terrainSnowShed
      * clamp(terrainSnowDescent / 90.0, 0.0, 1.0),
  );
}
// Both terms cover the same area. Their signed residual makes the material ID
// switch only where its influence is exactly zero; the previous max-selection
// retained ~full weight across the switch and painted a binary charcoal rock
// polygon into an otherwise continuous winter mountain.
let terrainCoverDelta = terrainSnowCover - terrainSlopeRock;
let terrainThirdId = select(
  ${SurfaceMaterial.Rock}.0, ${SurfaceMaterial.Snow}.0, terrainCoverDelta > 0.0);
let terrainThirdWeight = abs(terrainCoverDelta);

// 3-6: N-way height blend. k_i = h_i + w_i; b_i = max(k_i - (max k - d), 0),
// normalised. The transition depth d widens with the footprint so the blend
// does not alias at distance.
var terrainBlendDepth = mix(
  ${HEIGHT_BLEND_DEPTH_NEAR.toFixed(2)},
  ${HEIGHT_BLEND_DEPTH_FAR.toFixed(2)},
  clamp(terrainFootprint / 3.0, 0.0, 1.0),
);
// Wave R: widen the arbitration between candidates whose reference albedos
// are far apart. At depth 0.06 the near-range Rock/Snow blend was decided
// per texel by two uncorrelated height fields with a 4.8x albedo ratio — a
// literal black-and-white speckle band in the slope 0.47-0.55 window above
// the snowline.
let terrainThirdReferenceLuma = dot(
  terrainSurfaceReference(i32(terrainThirdId + 0.5)).rgb,
  vec3f(0.2126, 0.7152, 0.0722));
let terrainPrimaryReferenceLuma = dot(
  terrainSurfaceReference(i32(terrainAxis + 0.5)).rgb,
  vec3f(0.2126, 0.7152, 0.0722));
terrainBlendDepth = terrainBlendDepth
  * (1.0 + 3.0 * abs(terrainThirdReferenceLuma - terrainPrimaryReferenceLuma));

#ifdef TERRAIN_SURFACE_THREE_MATERIALS
let terrainWeight0 = (1.0 - terrainAxisFraction) * (1.0 - terrainThirdWeight);
let terrainWeight1 = terrainAxisFraction * (1.0 - terrainThirdWeight);
// Base candidates whose weight is negligible are skipped rather than sampled
// and multiplied by zero. The slope/snow candidate is sampled for every
// strictly positive residual and its height-blend contribution is multiplied
// by that residual below. That gate is what makes its Rock/Snow ownership
// change continuous at zero instead of allowing a tiny candidate weight to
// enter with a finite height-driven blend. Most ground still has an exact-zero
// residual, so the common fragment fetches one material rather than three.
// Legal under non-uniform control flow precisely because every sample carries
// explicit gradients.
let terrainActive0 = terrainWeight0 > 0.004;
let terrainActive1 = terrainWeight1 > 0.004;
let terrainActive2 = terrainThirdWeight > 0.0;
var terrainLayer0: TerrainSurfaceLayer;
var terrainLayer1: TerrainSurfaceLayer;
var terrainLayer2: TerrainSurfaceLayer;
var terrainKey0 = -1.0e9;
var terrainKey1 = -1.0e9;
var terrainKey2 = -1.0e9;
if (terrainActive0) {
  terrainLayer0 = terrainSurfaceSample(
    i32(terrainLowerId), terrainSamplePosition, terrainGeometricNormal,
    terrainWorldDdx, terrainWorldDdy, terrainDetailWeight);
  terrainKey0 = terrainLayer0.height + terrainWeight0;
}
if (terrainActive1) {
  terrainLayer1 = terrainSurfaceSample(
    i32(terrainUpperId), terrainSamplePosition, terrainGeometricNormal,
    terrainWorldDdx, terrainWorldDdy, terrainDetailWeight);
  terrainKey1 = terrainLayer1.height + terrainWeight1;
}
if (terrainActive2) {
  terrainLayer2 = terrainSurfaceSample(
    i32(terrainThirdId + 0.5), terrainSamplePosition, terrainGeometricNormal,
    terrainWorldDdx, terrainWorldDdy, terrainDetailWeight);
  terrainKey2 = terrainThirdWeight * (terrainLayer2.height + 1.0);
}
let terrainKeyMax = max(terrainKey0, max(terrainKey1, terrainKey2)) - terrainBlendDepth;
// A skipped candidate's key is far below the threshold, so its blend weight is
// exactly zero and the partition of unity is unaffected. At least one is
// always active: the three weights sum to 1.
var terrainBlend0 = max(terrainKey0 - terrainKeyMax, 0.0);
var terrainBlend1 = max(terrainKey1 - terrainKeyMax, 0.0);
var terrainBlend2 = max(terrainKey2 - terrainKeyMax, 0.0);
terrainBlend2 = terrainBlend2 * terrainThirdWeight;
let terrainBlendSum = max(terrainBlend0 + terrainBlend1 + terrainBlend2, 1e-5);
terrainBlend0 = terrainBlend0 / terrainBlendSum;
terrainBlend1 = terrainBlend1 / terrainBlendSum;
terrainBlend2 = terrainBlend2 / terrainBlendSum;
if (!terrainUsePageSplat) {
  // The macro fallback has no texel-scale height evidence to arbitrate. Use
  // its analytic coverage directly; feeding mean-height layers through the
  // height winner created a new contour where Rock first entered the blend.
  terrainBlend0 = 1.0 - terrainThirdWeight;
  terrainBlend1 = 0.0;
  terrainBlend2 = terrainThirdWeight;
}
var terrainAlbedo = terrainLayer0.albedo * terrainBlend0
  + terrainLayer1.albedo * terrainBlend1
  + terrainLayer2.albedo * terrainBlend2;
var terrainNormal = terrainLayer0.normal * terrainBlend0
  + terrainLayer1.normal * terrainBlend1
  + terrainLayer2.normal * terrainBlend2;
var terrainRoughness = terrainLayer0.roughness * terrainBlend0
  + terrainLayer1.roughness * terrainBlend1
  + terrainLayer2.roughness * terrainBlend2;
var terrainCavity = terrainLayer0.cavity * terrainBlend0
  + terrainLayer1.cavity * terrainBlend1
  + terrainLayer2.cavity * terrainBlend2;
var terrainF0 = terrainLayer0.f0 * terrainBlend0
  + terrainLayer1.f0 * terrainBlend1
  + terrainLayer2.f0 * terrainBlend2;
var terrainDiffuseRoughness = terrainLayer0.diffuseRoughness * terrainBlend0
  + terrainLayer1.diffuseRoughness * terrainBlend1
  + terrainLayer2.diffuseRoughness * terrainBlend2;
#ifdef TERRAIN_SURFACE_PAGE_CHANNELS
// Wave Q seam feather, wave-R re-target: page confidence is
// PIECEWISE-CONSTANT per residency level, so any binary gate draws a
// polygon edge; class strength fades on confidence perturbed by the cover
// noise. Wave R changed WHAT fades: a coarse texel's PRIMARY id is not
// wrong — only its sub-texel mixture is — so the fade target is the page's
// own primary (already sampled as layer0) plus the fragment-derived third
// candidate, never a grass overlay. Fading identity to grass repainted
// every distant mountain green (measured: a 700 m slope-0.4 face went
// 0.00 -> 0.73 grass share across the residency ladder while the
// classifier says Rock 0.91 at every level).
if (terrainUsePageSplat && terrainClassStrength < 0.996) {
  let terrainSeamThird = clamp(terrainThirdWeight, 0.0, 1.0);
  terrainAlbedo = mix(
    mix(terrainLayer0.albedo, terrainLayer2.albedo, terrainSeamThird),
    terrainAlbedo, terrainClassStrength);
  terrainNormal = mix(
    mix(terrainLayer0.normal, terrainLayer2.normal, terrainSeamThird),
    terrainNormal, terrainClassStrength);
  terrainRoughness = mix(
    mix(terrainLayer0.roughness, terrainLayer2.roughness, terrainSeamThird),
    terrainRoughness, terrainClassStrength);
  terrainCavity = mix(
    mix(terrainLayer0.cavity, terrainLayer2.cavity, terrainSeamThird),
    terrainCavity, terrainClassStrength);
  terrainF0 = mix(
    mix(terrainLayer0.f0, terrainLayer2.f0, terrainSeamThird),
    terrainF0, terrainClassStrength);
  terrainDiffuseRoughness = mix(
    mix(terrainLayer0.diffuseRoughness, terrainLayer2.diffuseRoughness, terrainSeamThird),
    terrainDiffuseRoughness, terrainClassStrength);
}
#endif
#else
// Tier 0's cap is two materials (§5.3), so the axis is rounded to its nearest
// integer instead of bracketed and only the strongest override survives. This
// is the Low-tier path and it ships unchanged past 4-6.
let terrainPrimaryId = floor(terrainAxis + 0.5);
let terrainWeight0 = 1.0 - terrainThirdWeight;
var terrainLayer0: TerrainSurfaceLayer;
var terrainLayer2: TerrainSurfaceLayer;
var terrainKey0 = -1.0e9;
var terrainKey2 = -1.0e9;
if (terrainWeight0 > 0.004) {
  terrainLayer0 = terrainSurfaceSample(
    i32(terrainPrimaryId), terrainSamplePosition, terrainGeometricNormal,
    terrainWorldDdx, terrainWorldDdy, terrainDetailWeight);
  terrainKey0 = terrainLayer0.height + terrainWeight0;
}
if (terrainThirdWeight > 0.0) {
  terrainLayer2 = terrainSurfaceSample(
    i32(terrainThirdId + 0.5), terrainSamplePosition, terrainGeometricNormal,
    terrainWorldDdx, terrainWorldDdy, terrainDetailWeight);
  terrainKey2 = terrainThirdWeight * (terrainLayer2.height + 1.0);
}
let terrainKeyMax = max(terrainKey0, terrainKey2) - terrainBlendDepth;
var terrainBlend0 = max(terrainKey0 - terrainKeyMax, 0.0);
var terrainBlend2 = max(terrainKey2 - terrainKeyMax, 0.0);
terrainBlend2 = terrainBlend2 * terrainThirdWeight;
let terrainBlendSum = max(terrainBlend0 + terrainBlend2, 1e-5);
terrainBlend0 = terrainBlend0 / terrainBlendSum;
terrainBlend2 = terrainBlend2 / terrainBlendSum;
if (!terrainUsePageSplat) {
  terrainBlend0 = 1.0 - terrainThirdWeight;
  terrainBlend2 = terrainThirdWeight;
}
var terrainAlbedo = terrainLayer0.albedo * terrainBlend0 + terrainLayer2.albedo * terrainBlend2;
var terrainNormal = terrainLayer0.normal * terrainBlend0 + terrainLayer2.normal * terrainBlend2;
var terrainRoughness = terrainLayer0.roughness * terrainBlend0
  + terrainLayer2.roughness * terrainBlend2;
var terrainCavity = terrainLayer0.cavity * terrainBlend0 + terrainLayer2.cavity * terrainBlend2;
var terrainF0 = terrainLayer0.f0 * terrainBlend0 + terrainLayer2.f0 * terrainBlend2;
var terrainDiffuseRoughness = terrainLayer0.diffuseRoughness * terrainBlend0
  + terrainLayer2.diffuseRoughness * terrainBlend2;
#ifdef TERRAIN_SURFACE_PAGE_CHANNELS
// Wave Q seam feather, wave-R re-target — the two-material path's copy of
// the block above (fade the mixture toward the page's own primary).
if (terrainUsePageSplat && terrainClassStrength < 0.996) {
  let terrainSeamThird = clamp(terrainThirdWeight, 0.0, 1.0);
  terrainAlbedo = mix(
    mix(terrainLayer0.albedo, terrainLayer2.albedo, terrainSeamThird),
    terrainAlbedo, terrainClassStrength);
  terrainNormal = mix(
    mix(terrainLayer0.normal, terrainLayer2.normal, terrainSeamThird),
    terrainNormal, terrainClassStrength);
  terrainRoughness = mix(
    mix(terrainLayer0.roughness, terrainLayer2.roughness, terrainSeamThird),
    terrainRoughness, terrainClassStrength);
  terrainCavity = mix(
    mix(terrainLayer0.cavity, terrainLayer2.cavity, terrainSeamThird),
    terrainCavity, terrainClassStrength);
  terrainF0 = mix(
    mix(terrainLayer0.f0, terrainLayer2.f0, terrainSeamThird),
    terrainF0, terrainClassStrength);
  terrainDiffuseRoughness = mix(
    mix(terrainLayer0.diffuseRoughness, terrainLayer2.diffuseRoughness, terrainSeamThird),
    terrainDiffuseRoughness, terrainClassStrength);
}
#endif
#endif

// Fix-pack T1 — the meso band. Between the material tile (2.3–8.9 m) and the
// kilometre wash NOTHING varied: no hue, no normal, no roughness — the clay
// look at every flying distance. Two rotationally-decorrelated octaves (71 m
// and 23 m) and an altitude-keyed strata octave supply the missing band as
// ALU-only structure: a world-space normal perturbation, a tonal/hue
// modulation and a roughness delta, faded by the MAJOR footprint axis so the
// band converges before it can alias. Strata engage on steep faces only, so
// runway and meadow flats keep their surveyed look.
// Per-octave Nyquist fades on the FULL 3D derivative: the horizontal-only
// footprint let the 9 m altitude-keyed strata alias at full amplitude on
// distant near-vertical cliffs (small ddx.xz, large ddx.y), and one shared
// 18→110 m fade held the 23 m octave at ~full weight past one period per
// pixel. Each octave now converges at roughly a quarter of its own
// wavelength per pixel.
// Wave Q (plastic-ground fix): keyed on the RAW major axis, all three meso
// octaves were dead by ~2 km of slant range at flight grazing angles — the
// 10 m-1 km band this block exists to provide vanished exactly where the eye
// still resolves it (the T2 lesson again). Procedural noise gets no help
// from the anisotropic sampler, so the full 16x credit would shimmer along
// the grazing axis; a 4x credit extends the band ~4x in range while each
// octave still converges within a few periods per pixel on that axis.
let terrainFootprintMajor3D = max(length(terrainWorldDdx), length(terrainWorldDdy));
let terrainFootprint3D = max(
  min(length(terrainWorldDdx), length(terrainWorldDdy)),
  terrainFootprintMajor3D * 0.25,
);
let terrainMesoWeightA = 1.0 - smoothstep(9.0, 34.0, terrainFootprint3D);
let terrainMesoWeightB = 1.0 - smoothstep(3.0, 11.0, terrainFootprint3D);
let terrainStrataWeight = 1.0 - smoothstep(1.2, 4.5, terrainFootprint3D);
if (terrainMesoWeightA > 0.001) {
  // Wave Q (reptile-mountain fix): meso A sampled the UNROTATED world axes,
  // quilting mountainsides with soft 71 m axis-aligned rectangles. Rotated
  // 37 degrees like B's 28, with the gradient carried back through the
  // transpose below.
  let terrainMesoA = terrainSurfaceValueGrad(
    (mat2x2f(0.798636, 0.601815, -0.601815, 0.798636) * terrainAbsolutePosition.xz)
      * ${(1 / 71).toFixed(9)} + vec2f(7.7, 51.2));
  let terrainMesoAGradWorld = mat2x2f(0.798636, -0.601815, 0.601815, 0.798636)
    * vec2f(terrainMesoA.y, terrainMesoA.z);
  let terrainMesoB = terrainSurfaceValueGrad(
    (mat2x2f(0.883, 0.469, -0.469, 0.883) * terrainAbsolutePosition.xz)
      * ${(1 / 23).toFixed(9)} + vec2f(29.1, 3.4));
  // The gradient came back in ROTATED coordinates; carry it to world space
  // through the transpose so the perturbation field stays curl-free and
  // aligned with its own value field.
  let terrainMesoBGradWorld = mat2x2f(0.883, -0.469, 0.469, 0.883)
    * vec2f(terrainMesoB.y, terrainMesoB.z);
  let terrainSteep = smoothstep(0.34, 0.62, terrainSlope);
  // Wave Q (reptile-mountain fix): the strata field was ONE value-noise
  // octave on (altitude, x+z) — a visible 9 m x 68 m lattice, constant along
  // the x = -z diagonal, painting long straight streaks across every cliff.
  // Two octaves at incommensurate scales on a rotated horizontal axis keep
  // the bedded-rock read without the lattice.
  let terrainStrataCoordinate = vec2f(
    terrainAbsolutePosition.y * ${(1 / 9).toFixed(9)},
    (terrainAbsolutePosition.x * 0.829038 + terrainAbsolutePosition.z * 0.559193)
      * ${(1 / 97).toFixed(9)});
  let terrainStrataA = terrainSurfaceValueGrad(terrainStrataCoordinate);
  let terrainStrataB = terrainSurfaceValueGrad(
    terrainStrataCoordinate * vec2f(2.317, 2.731) + vec2f(13.1, 4.7));
  let terrainStrataValue = mix(terrainStrataA.x, terrainStrataB.x, 0.35);
  let terrainStrataSlopeRaw = mix(terrainStrataA.y, terrainStrataB.y * 2.317, 0.35);
  // Along-strike break-up: without it every slope at the same altitude carries
  // the same band and the mountains read as contour-line stripes.
  let terrainStrataBreak = terrainSteep * (0.25 + 0.75 * terrainMesoA.x)
    * terrainStrataWeight;
  let terrainMesoSlope = (
    terrainMesoAGradWorld * 0.42 * terrainMesoWeightA
    + terrainMesoBGradWorld * 0.30 * terrainMesoWeightB
  ) * (0.4 + 0.9 * terrainSteep);
  let terrainStrataSlope = terrainStrataSlopeRaw * terrainStrataBreak * 0.32;
  terrainNormal = normalize(terrainNormal)
    + vec3f(-terrainMesoSlope.x, -terrainStrataSlope, -terrainMesoSlope.y);
  let terrainMesoTone = (terrainMesoA.x - 0.5) * 0.26 * terrainMesoWeightA
    + (terrainMesoB.x - 0.5) * 0.16 * terrainMesoWeightB
    + (terrainStrataValue - 0.5) * 0.18 * terrainStrataBreak;
  let terrainMesoHue = mix(
    vec3f(0.962, 0.988, 1.034),
    vec3f(1.038, 1.008, 0.955),
    mix(0.5, terrainMesoB.x, terrainMesoWeightB),
  );
  terrainAlbedo *= terrainMesoHue * (1.0 + terrainMesoTone) * terrainMesoWeightA
    + vec3f(1.0) * (1.0 - terrainMesoWeightA);
  terrainRoughness = clamp(
    terrainRoughness
      + (terrainMesoA.x - 0.5) * 0.14 * terrainMesoWeightA
      + (terrainStrataValue - 0.5) * 0.08 * terrainStrataBreak,
    0.02,
    1.0,
  );
}

// 3-4's macro wash goes on BEFORE the runway is painted: paint is a constant
// colour, and a kilometre-scale brightness ramp across a marking reads as a
// stain rather than as weather.
terrainAlbedo *= terrainMacroVariation * terrainMacroHue;

#ifdef TERRAIN_SURFACE_RUNWAY
// 3-9 paints asphalt, concrete and markings from the analytic airport SDF,
// over the top of whatever the splat says the ground is.
terrainRunwaySurface(
  terrainAbsolutePosition, terrainGeometricNormal,
  terrainWorldDdx, terrainWorldDdy, terrainDetailWeight,
  &terrainAlbedo, &terrainNormal, &terrainRoughness, &terrainCavity,
  &terrainF0, &terrainDiffuseRoughness,
);
#endif

// 3-7's wetness response, driven at last. The two response instructions are
// verbatim what 3-7 shipped; what changed is that terrainWetness is now a
// FIELD (6-5) instead of a uniform lane that carried a constant zero.
//
// SUBMERGED ground was the one case 3-7 could answer on its own, and it had to
// be: the first capture after this plugin landed turned every lake grey,
// because the WATER biome's primary is sand (it has to be — beach is its only
// neighbour on the ecotone axis) and dry sand is the brightest material in the
// table at 0.42. Wet it, then silt it, and the composite lands near the 0.08
// the old water palette used. That term is untouched here and stays
// authoritative under the sea.
let terrainSeaLevel = uniforms.terrainSurfaceWetness.y;
let terrainSubmerged = clamp((terrainSeaLevel - terrainAbsolutePosition.y) * 0.5 + 0.5, 0.0, 1.0);
// The freeboard 6-2's contract asks for, formed exactly as its docblock says:
// ground elevation minus STILL water level, positive above the waterline.
let terrainFreeboard = terrainAbsolutePosition.y - terrainSeaLevel;
let terrainBeachSlope = terrainSurfaceBeachSlope(terrainGeometricNormal.y);
// Sources 2 and 3 at the sea: the run-up's wet-sand persistence and the
// capillary fringe. Both are analytic — sea level and the published sea state
// exist in every world — so this half needs no channel and no sentinel.
let terrainShoreWetness = terrainSurfaceShoreWetness(
  terrainFreeboard,
  terrainBeachSlope,
  uniforms.terrainSurfaceWetness.x,
  uniforms.terrainSurfaceWetness.w,
  uniforms.terrainSurfaceShoreClock.x,
);
// Source 1's inland half, eroded-only: the lake bed and its bank fringe.
var terrainLakeWetness = vec2f(0.0, 0.0);
#ifdef TERRAIN_SURFACE_HYDROLOGY_CHANNELS
terrainLakeWetness = terrainSurfaceLakeWetness(terrainPageUv, terrainBeachSlope);
#endif
// A MAXIMUM, not a sum: ground is as wet as the wettest reason it has, and a
// maximum of terms each in [0, 1] cannot leave [0, 1].
let terrainSubmergedTotal = max(terrainSubmerged, terrainLakeWetness.x);
let terrainWetness = clamp(
  max(
    max(terrainSubmergedTotal, terrainShoreWetness),
    terrainLakeWetness.y,
  ),
  0.0,
  1.0);
terrainRoughness = mix(terrainRoughness, terrainRoughness * 0.35 + 0.02, terrainWetness);
terrainAlbedo *= mix(1.0, 0.62, terrainWetness);
// Silt, biofilm and the water column's own absorption on top of the wetting:
// a lake bed is not a beach, and red goes first. Wet SAND is wet, not tinted —
// only the two terms that mean "there is a water column over this ground" feed
// this, or a swash band would paint the beach green.
terrainAlbedo = mix(
  terrainAlbedo, terrainAlbedo * vec3f(0.26, 0.40, 0.44), terrainSubmergedTotal);

#ifdef TERRAIN_SURFACE_HYDROLOGY_CHANNELS
// 6-6, the appearance half of the shore-distance channel: WET LITTER.
//
// Forest duff at a water's edge is permanently soaked, and soaked duff is far
// darker and smoother than the dry needle litter the ForestFloor recipe
// synthesises. This is deliberately NOT a general ground wetness (that field
// is 6-5's, and it drives the block above): it is gated on the splat's own
// forest-floor share, so a gravel bar and a reed flat beside the same stream
// keep their own materials while the duff under the bankside trees goes dark.
var terrainForestFloorShare = 0.0;
if (i32(terrainLowerId) == ${SurfaceMaterial.ForestFloor}) {
  terrainForestFloorShare = terrainForestFloorShare + (1.0 - terrainAxisFraction);
}
if (i32(terrainUpperId) == ${SurfaceMaterial.ForestFloor}) {
  terrainForestFloorShare = terrainForestFloorShare + terrainAxisFraction;
}
let terrainWetLitter = terrainSurfaceRiparianBand(terrainPageUv)
  * clamp(terrainForestFloorShare, 0.0, 1.0);
terrainAlbedo *= mix(1.0, 0.68, terrainWetLitter);
terrainRoughness = mix(terrainRoughness, terrainRoughness * 0.62 + 0.02, terrainWetLitter);
#endif

// ---------------------------------------------------------------------------
// 6-8 — the canopy/terrain handoff.
//
// One law, two halves, and they are the SAME quantity: the canopy the
// renderer's own stems do not draw. Near the camera that residual is canopy
// you stand UNDER, so it takes direct sun out of the ground (QR-2's dappled
// light, deferred since the fix-pack as "a canopy-closure -> terrain-splat
// coupling"). Beyond the impostor radius nothing is drawn at all, so the same
// residual is canopy you LOOK AT and the ground has to be it.
//
// Coverage is conserved identically rather than approximately: the deficit is
// DEFINED as closure minus what geometry supplies, and the two halves are
// affine in the rendered share, which is continuous everywhere and reaches
// exactly zero at the impostor band's own cull edge. There is no ring to see
// because there is no discontinuity to see.
// ---------------------------------------------------------------------------
var terrainCanopyShade = 0.0;
#ifdef TERRAIN_SURFACE_PAGE_CHANNELS
{
  let terrainCanopyCover = terrainSurfaceCanopyClosure(terrainPageUv);
  if (terrainCanopyCover > 0.002) {
    let canopyRange = distance(fragmentInputs.vPositionW, scene.vEyePosition.xyz);
    let canopySplit = vegetationCanopyHandoff(
      terrainCanopyCover,
      vegetationCanopyRenderedShare(canopyRange, uniforms.terrainCanopyBands),
    );
    terrainCanopyShade = canopySplit.shade;
    // The surface half: the ground becomes the canopy's own material, at the
    // impostor's measured response rather than at a chosen colour.
    let canopySurface = canopySplit.surface;
    terrainAlbedo = mix(
      terrainAlbedo,
      vec3f(${TERRAIN_CANOPY_ALBEDO}),
      canopySurface);
    terrainRoughness = mix(
      terrainRoughness, ${TERRAIN_CANOPY_ROUGHNESS}, canopySurface);
    terrainF0 = mix(terrainF0, terrainF0 * ${TERRAIN_CANOPY_SPECULAR}, canopySurface);
    // Ambient: a per-fragment material cannot move environmentIntensity, and
    // AO multiplies the identical term. The canopy's AO factor IS the
    // impostor material's 0.62 probe trim, so the two representations answer
    // the sky with the same number.
    terrainCavity = terrainCavity
      * mix(1.0, ${TERRAIN_CANOPY_AMBIENT}, canopySurface);
  }
}
#endif

surfaceAlbedo = terrainAlbedo;
normalW = normalize(terrainNormal);
// Fix-pack T8: no composed normal may cross the geometric horizon — a normal
// past 90° to every light reads as a black line along whatever feature
// produced it (the reported artifact). Pull offenders back toward the
// geometric normal continuously instead of letting them wrap.
let terrainNormalAgreement = dot(normalW, terrainGeometricNormal);
normalW = normalize(
  normalW + terrainGeometricNormal * max(0.0, 0.12 - terrainNormalAgreement) * 4.0,
);
// Consumed by the regex injections below, which land after this hook: AO at
// the ambientOcclusionBlock call and roughness/F0 at their declarations.
var terrainSurfaceRoughness = clamp(terrainRoughness, 0.02, 1.0);
var terrainSurfaceCavity = clamp(terrainCavity, 0.0, 1.0);
var terrainSurfaceF0 = clamp(terrainF0, 0.0, 1.0);
var terrainSurfaceDiffuseRoughness = clamp(terrainDiffuseRoughness, 0.0, 1.0);
// Wave Q (plastic-ground fix): Babylon leaves Fresnel F90 at 1.0, so a low
// sun runs a 2-6% dielectric up to FULL WHITE grazing reflectance across
// both the direct GGX lobe and the sky-IBL lobe — the "wet plastic" dusk
// landscape. Real ground never gets there: shadowing/masking and multiple
// scattering on a rough surface eat the Schlick spike. Suppress harder the
// rougher the surface; smoother materials (snow) keep more of their glance.
var terrainSurfaceF90 = clamp(
  terrainSurfaceF0 * (2.0 + 6.0 * (1.0 - terrainSurfaceRoughness)),
  terrainSurfaceF0,
  0.5,
);
`;

/**
 * The regex injection anchors (`C3`, §3.2).
 *
 * Roughness and AO cannot be set from any standard hook —
 * `CUSTOM_FRAGMENT_BEFORE_LIGHTS` is emitted at `pbr.fragment.js:164`, one
 * line BEFORE `aoOut` is even declared — so the `!regex` form is not a
 * preference. The matched text is recorded verbatim in the decision log
 * because it is minified, unversioned, shipped WGSL and it WILL change on a
 * Babylon bump.
 *
 * The plan's AO anchor at `:245` is corrected here: that line sits inside
 * `#if defined(METALLICWORKFLOW) && defined(REFLECTIVITY) &&
 * defined(AOSTOREINMETALMAPRED)` and the terrain material binds no
 * reflectivity texture, so it never enters the compiled shader — and a
 * `!regex` that matches nothing is SILENT, which would have left AO looking
 * wired and never applying. The reachable anchor is the unguarded
 * `ambientOcclusionBlock` call.
 *
 * Only `$1`-style numeric back-references are supported
 * (`materialPluginManager.pure.js` `ReplaceRegExpSubstitutions`), so every
 * anchor captures itself and the injected code re-emits it.
 */
export const TERRAIN_SURFACE_INJECTION_ANCHORS = Object.freeze({
  ambientOcclusion: String.raw`!(aoOut=ambientOcclusionBlock\([\s\S]*?\);)`,
  roughness: String.raw`!(var roughness: f32=reflectivityOut\.roughness;var diffuseRoughness: f32=reflectivityOut\.diffuseRoughness;)`,
  reflectance: String.raw`!(var specularEnvironmentR0: vec3f=reflectivityOut\.colorReflectanceF0;)`,
});

/** The tokens assertion 57 looks for in the PROCESSED effect source. */
export const TERRAIN_SURFACE_INJECTION_TOKENS = Object.freeze([
  "aoOut.ambientOcclusionColor *= vec3f(terrainSurfaceCavity * terrainSkyVisibility);",
  "roughness = terrainSurfaceRoughness;",
  "diffuseRoughness = terrainSurfaceDiffuseRoughness;",
  "specularEnvironmentR0 = vec3f(terrainSurfaceF0);",
  "reflectivityOut.reflectanceF90 = vec3f(terrainSurfaceF90);",
  "reflectivityOut.colorReflectanceF90 = vec3f(terrainSurfaceF90);",
]);

const FRAGMENT_WGSL = Object.freeze({
  // 3-9's painter consumes terrainSurfaceSample and the helpers above, so it
  // is appended rather than emitted at its own injection point. The whole
  // block is compiled out when the world has no airport.
  CUSTOM_FRAGMENT_DEFINITIONS: `${FRAGMENT_DEFINITIONS}
#ifdef TERRAIN_SURFACE_RUNWAY
${RUNWAY_SURFACE_WGSL}
#endif
`,
  CUSTOM_FRAGMENT_BEFORE_LIGHTS: FRAGMENT_BEFORE_LIGHTS,
  // 4-7: the horizon map shadows DIRECT light only, at the same hook the
  // cloud-shadow receiver uses (priority 210). Babylon concatenates same-hook
  // code across plugins in priority order, so both multiply and neither
  // overwrites — which is exactly why every identifier here carries the
  // `terrain`/`terrainSurface` prefix the §5.6 convention requires.
  //
  // This is Gate 4B's payoff: a 3,000 m ridge shadows the valley behind it at
  // 40 km, where the cascaded shadow map has never reached.
  CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION: /* wgsl */ `
#ifndef UNLIT
// 6-8 absorbs QR-2 here, at the horizon shadow's hook and for its reason: a
// canopy occludes the SUN, and multiplying it into ambient as well would
// darken the same ground twice for one occluder. The strength is the canopy
// DEFICIT you stand under — what the near band failed to draw — so ground with
// a fully rendered stand above it takes nothing, and the term vanishes again
// past the impostor radius where the surface half takes over.
let terrainCanopyDirect = 1.0 - terrainCanopyShade * ${TERRAIN_CANOPY_SHADE};
finalDiffuse *= terrainHorizonShadow * terrainCanopyDirect;
#ifdef SPECULARTERM
finalSpecularScaled *= terrainHorizonShadow * terrainCanopyDirect;
#endif
#endif
`,
  [TERRAIN_SURFACE_INJECTION_ANCHORS.ambientOcclusion]: /* wgsl */ `$1
// 4-7: the baked sky visibility rides the same anchor as 3-1's cavity map.
// Both are ambient-only occlusion, and the ONE thing that must not happen is
// applying either to direct sunlight — that is the horizon map's job below,
// and doubling them would darken slopes twice for the same reason.
aoOut.ambientOcclusionColor *= vec3f(terrainSurfaceCavity * terrainSkyVisibility);
`,
  [TERRAIN_SURFACE_INJECTION_ANCHORS.roughness]: /* wgsl */ `$1
roughness = terrainSurfaceRoughness;
diffuseRoughness = terrainSurfaceDiffuseRoughness;
`,
  [TERRAIN_SURFACE_INJECTION_ANCHORS.reflectance]: /* wgsl */ `$1
specularEnvironmentR0 = vec3f(terrainSurfaceF0);
reflectanceF0 = terrainSurfaceF0;
reflectivityOut.reflectanceF90 = vec3f(terrainSurfaceF90);
reflectivityOut.colorReflectanceF90 = vec3f(terrainSurfaceF90);
`,
});

/**
 * The one owner of terrain surface appearance.
 *
 * Priority 180 — the slot `TerrainMaterialPlugin` held, which keeps this
 * plugin's writes to `surfaceAlbedo`/`normalW` ahead of the cloud-shadow
 * receiver (210) and the aerial-perspective receiver (205), both of which
 * operate on the final colour. `R-3F`: every function this file defines
 * carries a `terrainSurface` prefix, so a collision with another plugin's
 * `CUSTOM_FRAGMENT_DEFINITIONS` is a compile error rather than a shadowed
 * function.
 */
export class TerrainSurfacePlugin extends MaterialPluginBase {
  private originX = 0;
  private originZ = 0;
  private albedoHeightArray: BaseTexture | null = null;
  private normalMaterialArray: BaseTexture | null = null;
  private triplanarMode: TerrainTriplanarMode = "biplanar";
  private heightBlendMaxMaterials = 3;
  private runwayEnabled = false;
  private runwayFrame: readonly [number, number, number, number] = [0, 0, 0, 1];
  private runwayShape: readonly [number, number, number, number] = [0, 0, 0, 0];
  private detileWarp = DEFAULT_DETILE_WARP;
  /**
   * `6-5`'s field drivers, replacing `3-7`'s never-driven constant.
   *
   * A zero excursion is the glassy-sea default and is exactly what an
   * un-driven build gets: `waterShoreWetness` returns 0 for it, so the field
   * collapses to the sea-level submerged band plus the capillary fringe with
   * no branch of its own.
   */
  private swashExcursionMeters = 0;
  private radianFrequency = 0;
  private runupClockSeconds = 0;
  private snowlineMeters = TERRAIN_REFERENCE_SNOWLINE_OFFSET_METERS;
  private referenceSnowlineMeters = TERRAIN_REFERENCE_SNOWLINE_OFFSET_METERS;
  private seaLevelMeters = 0;
  private readonly tiling = new Float32Array(SURFACE_MATERIAL_COUNT * 4);
  private readonly season = new Float32Array(SURFACE_MATERIAL_COUNT * 4);
  private placeholderArray: RawTexture2DArray | null = null;
  private occlusionAtlas: BaseTexture | null = null;
  private horizonAtlasA: BaseTexture | null = null;
  private horizonAtlasB: BaseTexture | null = null;
  private splatAtlases: readonly (BaseTexture | null)[] = [null, null, null, null];
  /** `6-6`: null in every analytic world, which is what removes the define. */
  private shoreDistanceAtlas: BaseTexture | null = null;
  /** `6-5`: `lakeDepth`'s first named consumer; null on the same gate. */
  private lakeDepthAtlas: BaseTexture | null = null;
  private seasonBlend = 0;
  private pageAtlasShape: readonly [number, number, number, number] = [1, 1, 1, 0];
  private pageAtlasGrid: readonly [number, number, number, number] = [1, 512, 1, 0.02];
  private sunDirection: readonly [number, number, number] = [0, 1, 0];
  private heightAtlasTexture: BaseTexture | null = null;
  private heightAtlasShape: readonly [number, number, number, number] = [1, 1, 0, 1];
  /**
   * `6-8`: (near band radius, impostor radius, far floor share, canopy height).
   *
   * The default is the G-target tier's law, so a material bound before the
   * clipmap publishes a profile still hands off correctly rather than
   * collapsing the ramp to "everything is canopy" at zero range.
   */
  private canopyBands: readonly [number, number, number, number] = [
    150, 3_000, 0.045, CANOPY_DOMINANT_HEIGHT_METERS,
  ];
  private cdlodEnabled = false;

  constructor(material: PBRMaterial) {
    super(
      material,
      "terrain-surface",
      180,
      {
        TERRAIN_SURFACE_TRIPLANAR: false,
        TERRAIN_SURFACE_PLANAR_ONLY: false,
        TERRAIN_SURFACE_THREE_MATERIALS: false,
        TERRAIN_SURFACE_RUNWAY: false,
        TERRAIN_SURFACE_PAGE_CHANNELS: false,
        // 6-6. Declared here as well as set in prepareDefines: a define the
        // constructor does not list is never registered with the material, so
        // its #ifdef silently reads false and the block vanishes from a shader
        // that was supposed to have it. That failure is invisible to
        // prepareDefines-only tests, which is why the GPU wrapper test asserts
        // the compiled fragment source.
        TERRAIN_SURFACE_HYDROLOGY_CHANNELS: false,
        TERRAIN_SURFACE_CDLOD: false,
      },
      true,
      // enable = false at construction, as CloudShadowMaterialPlugin does, so
      // a shader is never compiled with unbound array samplers. setArrays()
      // turns it on once the textures exist.
      false,
    );
    this.doNotSerialize = true;
    // Must precede any _enable call, or hardBindForSubMesh never registers
    // and the first terrain draw dies in createBindGroup.
    this.registerForExtraEvents = true;
    // The BRDF rows never change at runtime: 3-0 fixes them.
    SURFACE_MATERIALS.forEach((spec, index) => {
      this.tiling[index * 4] = 1 / spec.tilingPeriodMeters;
      this.tiling[index * 4 + 1] = spec.triplanar ? 1 : 0;
      this.tiling[index * 4 + 2] = spec.f0;
      this.tiling[index * 4 + 3] = spec.diffuseRoughness;
      this.season[index * 4] = 1;
      this.season[index * 4 + 1] = 1;
      this.season[index * 4 + 2] = 1;
      this.season[index * 4 + 3] = 0;
    });
  }

  override getClassName(): string {
    return "TerrainSurfacePlugin";
  }

  override isCompatible(): boolean {
    return true;
  }

  setWorldOrigin(x: number, z: number): void {
    this.originX = Number.isFinite(x) ? x : 0;
    this.originZ = Number.isFinite(z) ? z : 0;
  }

  /** `3-1`'s two arrays. Enabling here is what keeps the samplers bound. */
  setArrays(albedoHeight: BaseTexture, normalMaterial: BaseTexture): void {
    this.albedoHeightArray = albedoHeight;
    this.normalMaterialArray = normalMaterial;
    this._enable(true);
    this.markAllDefinesAsDirty();
  }

  /**
   * 1x1 stand-ins for the material arrays, so the plugin can be enabled for
   * its GEOMETRY before its appearance exists.
   *
   * `3-1` builds the real arrays one material per frame from the frame loop —
   * about ten frames — and before `4-4` that only cost ten frames of untextured
   * ground. It now also gates vertex displacement, and ten frames of FLAT
   * ground is a different thing entirely: the aircraft would spawn inside a
   * plane. Binding a placeholder is the same trick `CloudShadowMaterialPlugin`
   * uses for its projection texture, for the same reason: an enabled plugin
   * with an unbound sampler dies in `createBindGroup`.
   */
  private fallbackArray(scene: Scene): BaseTexture {
    if (!this.placeholderArray) {
      const texels = new Uint8Array(SURFACE_MATERIAL_COUNT * 4);
      texels.fill(128);
      this.placeholderArray = new RawTexture2DArray(
        texels,
        1,
        1,
        SURFACE_MATERIAL_COUNT,
        Constants.TEXTUREFORMAT_RGBA,
        scene,
        false,
        false,
        Texture.NEAREST_SAMPLINGMODE,
        Constants.TEXTURETYPE_UNSIGNED_BYTE,
      );
      this.placeholderArray.name = "terrain-surface-placeholder";
    }
    return this.placeholderArray;
  }

  get hasArrays(): boolean {
    return this.albedoHeightArray !== null && this.normalMaterialArray !== null;
  }

  /** §5.3's two shader-shaping rows. A datum read, never a tier branch. */
  setSamplingProfile(mode: TerrainTriplanarMode, heightBlendMaxMaterials: number): void {
    const capped = Math.max(2, Math.min(4, Math.round(heightBlendMaxMaterials)));
    if (mode === this.triplanarMode && capped === this.heightBlendMaxMaterials) return;
    this.triplanarMode = mode;
    this.heightBlendMaxMaterials = capped;
    this.markAllDefinesAsDirty();
  }

  /**
   * `3-9`: switch on the airport SDF layers. Passing null compiles them out
   * entirely, so a world without an airport pays nothing.
   */
  setRunway(airport: Readonly<AirportDefinition> | null): void {
    const enabled = airport !== null;
    if (airport) {
      const binding = resolveRunwaySurfaceBinding(airport);
      this.runwayFrame = binding.frame;
      this.runwayShape = binding.shape;
    }
    if (enabled === this.runwayEnabled) return;
    this.runwayEnabled = enabled;
    this.markAllDefinesAsDirty();
  }

  /** The phase's first tuning knob (`3-4`). */
  setDetileWarp(amount: number): void {
    this.detileWarp = Number.isFinite(amount) ? Math.max(0, amount) : DEFAULT_DETILE_WARP;
  }

  /**
   * `6-5`: the sea state `3-7`'s wetness response has been waiting for.
   *
   * This replaces `setWetness`, which carried a scalar constant and never had a
   * caller. The swell is `SpectralOceanSystem.shoreRunupSwell()` — the CPU twin
   * of the band the shader's own dominant-cascade rule selects, agreement
   * pinned rather than assumed (D-12(c)) — and `timeSeconds` must be the WATER's
   * clock, or the sand would dry out of time with the surf that wetted it.
   *
   * The clock is wrapped HERE, in f64, by 6-2's own `waterRunupClock`: the
   * uniform is f32, and an unwrapped session clock loses phase resolution long
   * before the 4096 s wrap would be visible against surf.
   */
  setShoreWetness(swell: Readonly<WaterShoreSwell>, timeSeconds: number): void {
    const excursion = swell.excursionMeters;
    const frequency = swell.radianFrequency;
    this.swashExcursionMeters = Number.isFinite(excursion) ? Math.max(0, excursion) : 0;
    this.radianFrequency = Number.isFinite(frequency) ? Math.max(0, frequency) : 0;
    this.runupClockSeconds = Number.isFinite(timeSeconds)
      ? waterRunupClock(timeSeconds)
      : 0;
  }

  /**
   * `3-10`. Anchored at the reference day, so the default clock leaves every
   * tint at exactly 1 and the tuned world unchanged.
   */
  setSeason(dayOfYear: number, latitudeDegrees: number, seaLevelMeters: number): void {
    const day = Number.isFinite(dayOfYear) ? dayOfYear : TERRAIN_REFERENCE_DAY_OF_YEAR;
    const latitude = Number.isFinite(latitudeDegrees) ? latitudeDegrees : 45;
    for (const spec of SURFACE_MATERIALS) {
      const response = surfaceSeasonalResponse(spec, day, latitude);
      this.season[spec.id * 4] = response.tint[0];
      this.season[spec.id * 4 + 1] = response.tint[1];
      this.season[spec.id * 4 + 2] = response.tint[2];
      this.season[spec.id * 4 + 3] = response.roughnessDelta;
    }
    this.seaLevelMeters = Number.isFinite(seaLevelMeters) ? seaLevelMeters : 0;
    this.snowlineMeters = seasonalSnowlineMeters(seaLevelMeters, day, latitude);
    this.referenceSnowlineMeters = seasonalSnowlineMeters(
      seaLevelMeters,
      TERRAIN_REFERENCE_DAY_OF_YEAR,
      latitude,
    );
  }

  /**
   * `4-7`: bind the channel pages and describe the atlas geometry.
   *
   * `gridEdge` and `slotEdge` come from the atlas, not from a constant here:
   * the slot budget is a profile datum, so a tier change reshapes the atlas
   * and the shader's addressing has to follow it in the same frame.
   */
  setChannelAtlas(
    occlusion: BaseTexture | null,
    horizonA: BaseTexture | null,
    horizonB: BaseTexture | null,
    splat: readonly (BaseTexture | null)[],
    /**
     * `6-6`: the signed shore-distance aux resource, or null. Null is not a
     * fallback value — it removes the define, and with it the binding, the
     * load and the wet-litter ALU, which is what keeps the shipping analytic
     * build byte- AND cost-identical.
     */
    shoreDistance: BaseTexture | null,
    /**
     * `6-5`: the lake-depth aux resource, or null. Same gate, same reason — and
     * the two travel together because the shore distance's own wet mask IS
     * `lakeDepth > 0`, so a build that has one and not the other would be
     * reading two halves of one waterline from different frames.
     */
    lakeDepth: BaseTexture | null,
    shape: {
      readonly atlasEdge: number;
      readonly slotEdge: number;
      readonly core: number;
      readonly gutter: number;
      readonly gridEdge: number;
      readonly basePageExtentMeters: number;
    },
  ): void {
    const enabled = occlusion !== null && horizonA !== null && horizonB !== null;
    const hydrologyEnabled = enabled && shoreDistance !== null && lakeDepth !== null;
    const hydrologyChanged = hydrologyEnabled !== (this.shoreDistanceAtlas !== null);
    this.occlusionAtlas = occlusion;
    this.horizonAtlasA = horizonA;
    this.horizonAtlasB = horizonB;
    this.splatAtlases = splat;
    this.shoreDistanceAtlas = hydrologyEnabled ? shoreDistance : null;
    this.lakeDepthAtlas = hydrologyEnabled ? lakeDepth : null;
    this.pageAtlasShape = [shape.atlasEdge, shape.slotEdge, shape.core, shape.gutter];
    this.pageAtlasGrid = [
      shape.gridEdge,
      shape.basePageExtentMeters,
      1,
      this.pageAtlasGrid[3],
    ];
    if (
      hydrologyChanged
      || enabled === (this.occlusionAtlas !== null && this.horizonAtlasA !== null)
    ) {
      this.markAllDefinesAsDirty();
    }
  }

  /**
   * `4-4`/`4-5`: bind the height atlas and switch the vertex path to the CDLOD
   * node record.
   *
   * Passing null restores the CPU tile path, which is what the Node suite and
   * NullEngine run — the whole displacement path compiles out rather than
   * binding an unbound sampler.
   */
  setHeightAtlas(
    texture: BaseTexture | null,
    shape: {
      readonly atlasEdge: number;
      readonly slotEdge: number;
      readonly gutter: number;
      readonly gridEdge: number;
    },
  ): void {
    const enabled = texture !== null;
    this.heightAtlasTexture = texture;
    this.heightAtlasShape = [shape.atlasEdge, shape.slotEdge, shape.gutter, shape.gridEdge];
    if (enabled === this.cdlodEnabled) return;
    this.cdlodEnabled = enabled;
    // The plugin has to be ON for the vertex path, whether or not `3-1`'s
    // arrays have finished building.
    if (enabled) this._enable(true);
    this.markAllDefinesAsDirty();
  }

  get isCdlod(): boolean {
    return this.cdlodEnabled;
  }

  /** `4-6`: the cross-fade weight between the two resident season buckets. */
  setSeasonBlend(blend: number): void {
    this.seasonBlend = Number.isFinite(blend) ? Math.min(1, Math.max(0, blend)) : 0;
  }

  /**
   * `6-8`: the tier's vegetation band radii, for the canopy handoff.
   *
   * These are the rendered-density law's own numbers, handed down from the
   * quality profile rather than re-derived here: how far geometry reaches is a
   * vegetation fact, and the ground's job is only to carry whatever the
   * geometry does not.
   */
  setCanopyBands(
    nearRadiusMeters: number,
    impostorRadiusMeters: number,
    farFloorShare: number,
  ): void {
    if (
      !Number.isFinite(nearRadiusMeters)
      || !Number.isFinite(impostorRadiusMeters)
      || !Number.isFinite(farFloorShare)
      || nearRadiusMeters <= 0
      || impostorRadiusMeters <= nearRadiusMeters
    ) {
      throw new RangeError("Canopy bands need a positive near radius inside the impostor radius");
    }
    this.canopyBands = [
      nearRadiusMeters,
      impostorRadiusMeters,
      Math.min(1, Math.max(0, farFloorShare)),
      CANOPY_DOMINANT_HEIGHT_METERS,
    ];
  }

  /**
   * The direction TOWARD the sun, in world space (Babylon's directional light
   * points the other way). Only the horizon shadow reads it.
   */
  setSunDirection(x: number, y: number, z: number): void {
    const length = Math.hypot(x, y, z);
    this.sunDirection = length > 1e-6 ? [x / length, y / length, z / length] : [0, 1, 0];
  }

  override prepareDefines(defines: MaterialDefines): void {
    defines["TERRAIN_SURFACE_TRIPLANAR"] = this.triplanarMode === "triplanar";
    defines["TERRAIN_SURFACE_PLANAR_ONLY"] = this.triplanarMode === "planar";
    // Phase 3's provisional splat offers at most three candidates; 4-6's page
    // splat spends the rest of the tier's cap.
    defines["TERRAIN_SURFACE_THREE_MATERIALS"] = this.heightBlendMaxMaterials >= 3;
    defines["TERRAIN_SURFACE_RUNWAY"] = this.runwayEnabled;
    defines["TERRAIN_SURFACE_CDLOD"] = this.cdlodEnabled;
    defines["TERRAIN_SURFACE_PAGE_CHANNELS"] =
      this.occlusionAtlas !== null && this.horizonAtlasA !== null && this.horizonAtlasB !== null;
    // 6-6: implies PAGE_CHANNELS by construction (setChannelAtlas clears the
    // shore atlas whenever the channel atlas is absent), so the hydrology block
    // may use terrainPageUv without a second guard.
    // 6-5 rides the SAME define rather than adding one: `lakeDepth` and
    // `shoreDistance` come from one hydrology upload gate and describe one
    // waterline, so a permutation that has one without the other does not
    // exist. Declared in the constructor's map above, without which the
    // `#ifdef` reads false in silence.
    defines["TERRAIN_SURFACE_HYDROLOGY_CHANNELS"] =
      this.shoreDistanceAtlas !== null && this.lakeDepthAtlas !== null;
  }

  override getSamplers(samplers: string[]): void {
    for (const name of [
      "terrainSurfaceAlbedo",
      "terrainSurfaceNormal",
      "terrainOcclusionAtlas",
      "terrainHorizonAtlasA",
      "terrainHorizonAtlasB",
      "terrainHeightAtlas",
      "terrainSplatId",
      "terrainSplatWeightLo",
      "terrainSplatWeightHi",
      "terrainShoreDistanceAtlas",
      "terrainLakeDepthAtlas",
    ]) {
      if (!samplers.includes(name)) samplers.push(name);
    }
  }

  override getAttributes(attributes: string[]): void {
    if (this.cdlodEnabled) {
      // 4-5: the node record replaces the per-vertex splat lane. Declaring
      // `color` here as well would ask Babylon for a buffer the one shared
      // grid does not have.
      for (const name of ["terrainNodeA", "terrainNodeB"]) {
        if (!attributes.includes(name)) attributes.push(name);
      }
      return;
    }
    // The splat lane. useVertexColors is false on the terrain meshes, so
    // Babylon never defines VERTEXCOLOR and this attribute is the plugin's.
    if (!attributes.includes("color")) attributes.push("color");
  }

  override hardBindForSubMesh(uniformBuffer: UniformBuffer): void {
    const scene = this._material.getScene();
    uniformBuffer.setTexture(
      "terrainSurfaceAlbedo",
      this.albedoHeightArray ?? this.fallbackArray(scene),
    );
    uniformBuffer.setTexture(
      "terrainSurfaceNormal",
      this.normalMaterialArray ?? this.fallbackArray(scene),
    );
    if (this.occlusionAtlas) {
      uniformBuffer.setTexture("terrainOcclusionAtlas", this.occlusionAtlas);
    }
    if (this.horizonAtlasA) {
      uniformBuffer.setTexture("terrainHorizonAtlasA", this.horizonAtlasA);
    }
    if (this.horizonAtlasB) {
      uniformBuffer.setTexture("terrainHorizonAtlasB", this.horizonAtlasB);
    }
    const splatNames = [
      "terrainSplatId",
      "terrainSplatWeightLo",
      "terrainSplatWeightHi",
    ] as const;
    splatNames.forEach((name, index) => {
      const texture = this.splatAtlases[index];
      if (texture) uniformBuffer.setTexture(name, texture);
    });
    if (this.shoreDistanceAtlas) {
      // r16sint: no sampler is declared beside it, so this binds a sint
      // sampled texture that only textureLoad may read — the same discipline
      // the r32float height atlas follows.
      uniformBuffer.setTexture("terrainShoreDistanceAtlas", this.shoreDistanceAtlas);
    }
    if (this.lakeDepthAtlas) {
      // r16float, and NO sampler is declared beside it either: the shader only
      // ever textureLoads it, so this adds a sampled-texture slot and no
      // sampler slot — the same discipline the shore-distance and height
      // atlases follow.
      uniformBuffer.setTexture("terrainLakeDepthAtlas", this.lakeDepthAtlas);
    }
    if (this.heightAtlasTexture) {
      // r32float: Babylon flips the binding to `unfilterable-float` and its
      // sampler to `non-filtering` automatically, because
      // `textureFloatLinearFiltering` is false — which is why the shader may
      // only ever `textureLoad` it.
      uniformBuffer.setTexture("terrainHeightAtlas", this.heightAtlasTexture);
    }
  }

  override getUniforms(): {
    ubo: Array<{ name: string; size: number; type: string; arraySize?: number }>;
  } {
    return {
      ubo: [
        { name: "terrainWorldOrigin", size: 2, type: "vec2" },
        { name: "terrainSurfaceTuning", size: 4, type: "vec4" },
        // 6-5 spent this vec4's two idle lanes rather than adding two: x was
        // 3-7's never-driven wetness constant and w was reserved-zero. They now
        // carry the swash excursion and the swell's radian frequency; y (sea
        // level) and z (the reference snowline) are unchanged, so every
        // existing reader of this uniform reads exactly what it read before.
        { name: "terrainSurfaceWetness", size: 4, type: "vec4" },
        // 6-5: the wrapped run-up clock, in seconds. It cannot ride the vec4
        // above — the excursion and the frequency filled it — and it must be
        // declared unconditionally, like the runway frame, because Babylon
        // collects the UBO layout once.
        { name: "terrainSurfaceShoreClock", size: 4, type: "vec4" },
        // 4-7: (atlasEdge, slotEdge, core, gutter) and
        // (gridEdge, basePageExtent, occlusionStrength, horizonSoftness).
        { name: "terrainPageAtlas", size: 4, type: "vec4" },
        { name: "terrainPageAtlasGrid", size: 4, type: "vec4" },
        { name: "terrainSunDirection", size: 4, type: "vec4" },
        // 6-8: (near band radius, impostor radius, far floor share, canopy
        // height). The first three are the tier's rendered-density law; the
        // fourth is vegetation's own canopy-top constant. Declared
        // unconditionally for the same reason the runway frame is.
        { name: "terrainCanopyBands", size: 4, type: "vec4" },
        // 4-4: (atlasEdge, slotEdge, gutter, gridEdge) for the height atlas.
        { name: "terrainHeightAtlasShape", size: 4, type: "vec4" },
        {
          name: "terrainMaterialTiling",
          size: 4,
          type: "vec4",
          arraySize: SURFACE_MATERIAL_COUNT,
        },
        {
          name: "terrainMaterialSeason",
          size: 4,
          type: "vec4",
          arraySize: SURFACE_MATERIAL_COUNT,
        },
        // 3-9's airport frame and shape. Declared unconditionally: Babylon
        // collects the UBO layout once, and a define-dependent layout would
        // change the buffer's size behind the bind group.
        ...RUNWAY_SURFACE_UNIFORMS.map((entry) => ({ ...entry })),
      ],
    };
  }

  override bindForSubMesh(uniformBuffer: UniformBuffer): void {
    uniformBuffer.updateFloat2("terrainWorldOrigin", this.originX, this.originZ);
    uniformBuffer.updateFloat4(
      "terrainSurfaceTuning",
      this.detileWarp,
      HEIGHT_BLEND_DEPTH_NEAR,
      HEIGHT_BLEND_DEPTH_FAR,
      this.snowlineMeters,
    );
    uniformBuffer.updateFloat4(
      "terrainSurfaceWetness",
      // x: 6-5's Hunt excursion, sqrt(H L0) in metres. The fragment multiplies
      // it by its OWN clamped beach slope, because the excursion is slope-free
      // and only the conversion to an elevation is not.
      this.swashExcursionMeters,
      // y: sea level, so the submerged half of the wetness response can exist
      // wherever the field's swash half does not reach.
      this.seaLevelMeters,
      // z: the REFERENCE snowline, so the shader can tell how far the current
      // one has descended and contribute nothing at the reference day.
      this.referenceSnowlineMeters,
      // w: 6-5's radian frequency — the ONE temporal frequency in the run-up,
      // and the phase lock that keeps the sand drying in time with the surf.
      this.radianFrequency,
    );
    uniformBuffer.updateFloat4(
      "terrainSurfaceShoreClock",
      this.runupClockSeconds,
      0,
      0,
      0,
    );
    uniformBuffer.updateFloatArray("terrainMaterialTiling", this.tiling);
    uniformBuffer.updateFloatArray("terrainMaterialSeason", this.season);
    uniformBuffer.updateFloat4("terrainPageAtlas", ...this.pageAtlasShape);
    uniformBuffer.updateFloat4("terrainPageAtlasGrid", ...this.pageAtlasGrid);
    // w carries the season cross-fade: one vec4 rather than a second one for
    // a single scalar, and the two are read in the same block.
    uniformBuffer.updateFloat4("terrainSunDirection", ...this.sunDirection, this.seasonBlend);
    uniformBuffer.updateFloat4("terrainCanopyBands", ...this.canopyBands);
    uniformBuffer.updateFloat4("terrainHeightAtlasShape", ...this.heightAtlasShape);
    uniformBuffer.updateFloat4("terrainRunwayFrame", ...this.runwayFrame);
    uniformBuffer.updateFloat4("terrainRunwayShape", ...this.runwayShape);
  }

  override getCustomCode(
    shaderType: string,
    shaderLanguage = ShaderLanguage.GLSL,
  ): { [pointName: string]: string } | null {
    // WebGPU-only by design; the renderer never compiles GLSL.
    if (shaderLanguage !== ShaderLanguage.WGSL) return null;
    if (shaderType === "vertex") return { ...TERRAIN_SURFACE_VERTEX_WGSL };
    if (shaderType === "fragment") return { ...FRAGMENT_WGSL };
    return null;
  }
}
