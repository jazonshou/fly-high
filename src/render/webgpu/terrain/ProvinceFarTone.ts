import { smoothstep } from "@/src/world/noise";
import {
  CLIMATE_PROVINCE_METERS_PER_TEMPERATURE,
  CLIMATE_PROVINCE_SNOWLINE_RESPONSE,
} from "@/src/world/climateProvince";
import {
  BOREAL_COLD_FULL,
  BOREAL_COLD_ONSET,
  TUNDRA_COLD_FULL,
  TUNDRA_COLD_ONSET,
  borealShare,
  tundraShare,
} from "@/src/world/coldBiomes";
import {
  CANOPY_SURFACE_ALBEDO,
  DRY_PROVINCE_DESERT_FULL,
  DRY_PROVINCE_DESERT_ONSET,
  DRY_PROVINCE_PARKLAND_FULL,
  DRY_PROVINCE_PARKLAND_ONSET,
  dryProvinceShares,
} from "@/src/render/webgpu/detail/densityField";
import { TROPICAL_COAST, tropicalCoastWeight } from "@/src/world/tropicalCoast";
import {
  SurfaceMaterial,
  surfaceMaterialSpec,
  type SurfaceMaterialId,
} from "./surfaceMaterials";

/**
 * What the far fallback paints in a climate province: the biome's TONE where
 * no page names a material, its canopy's colour where the canopy handoff paints
 * forest, and the thermal lift its altitude bands read.
 *
 * The fallback (`TerrainSurfacePlugin.ts`, "the macro fallback") draws ground
 * no trusted page classifies: zero-trust coarse pages whose pair is not two
 * swards, and unresident pages. It starts from Grass by assumption and adds
 * rock and snow from REAL elevation; the canopy handoff paints the forest no
 * stem draws in one measured temperate colour. Inside the temperate core all
 * of that is what a page would say. Outside it each was a ring that followed
 * the aeroplane: a tundra's snowline stopped at the page edge, a desert went
 * Grass-green, a taiga's near crowns were 10% darker than the paint beyond.
 *
 * Three quantities, derived from the province once per VERTEX
 * (`ClimateProvinceField.ts`) and handed to the fragment as varyings:
 *
 * - **thermal lift**, metres: `-temperatureOffset x 2,450`, what thermal height
 *   adds to real height. The fallback's alpine rock and the turf-relief gate add
 *   all of it, the snow blanket `CLIMATE_PROVINCE_SNOWLINE_RESPONSE` of it, the
 *   same split the classifier makes.
 * - **base tone**, a per-channel delta on the Grass-by-assumption albedo: the
 *   colour of the province's OPEN SWARD over the colour of Grass, minus one.
 * - **canopy share**, SIGNED: above 0, how far the canopy paint darkens toward
 *   a taiga's or a desert's drawn crowns (`PROVINCE_FAR_CANOPY_PAINT_RATIO`);
 *   below 0, how far it greens toward a tropical forest's
 *   (`PROVINCE_FAR_CANOPY_TROPICAL_RATIO`). One lane carries both because no
 *   point has both: the tropics need a warm province (boreal needs a cold one)
 *   that is not dry (a desert needs a dry one), so an interpolated share
 *   crosses 0 between them, which is the temperate paint.
 *
 * FIVE FLOATS, BECAUSE THERE IS NO SPARE INTERPOLATOR. The terrain's beauty
 * pipeline already spends all 16 of WebGPU's fragment inputs (a new varying
 * failed pipeline creation: 17 = 16 + front_facing), so the province rides
 * lanes the terrain already interpolates: the base tone in `terrainSplat.xyz`
 * (idle provisional ids), the lift and the canopy share in `terrainPageLocal`'s
 * z and w (a vec2 widened to a vec4 under the define).
 *
 * DELTAS, NOT RATIOS. A varying that is 1.0 at three vertices need not
 * interpolate to exactly 1.0, but one that is 0 at three vertices is exactly 0,
 * and `x + x * 0 === x`. Every share below is exactly 0 in the temperate core
 * (`smoothstep` saturates to 0 below its edge), so the core's ground is
 * bit-identical.
 *
 * THE SHARES ARE THE BIOMES' OWN. Boreal and tundra are `coldBiomes.ts`'s,
 * desert (arid) and parkland are `densityField.ts`'s `dryProvinceShares`, so
 * the far ground turns where the near ground and the trees turn. Overlapping
 * shares (a cold desert) are averaged, never stacked: weights are the shares
 * divided by `max(1, sum)`. The tropical share is `tropicalCoast.ts`'s weight.
 *
 * Class P: pure numbers with a WGSL twin for the terrain vertex stage.
 */

/** A mix of surface materials, by share; the shares of one mix sum to 1. */
type SwardMix = Readonly<Partial<Record<SurfaceMaterialId, number>>>;

/**
 * The OPEN SWARD each province shows on gentle ground, as the biome threads
 * measured it from the classifier on forced provinces (gentle open ground,
 * reference day). Rock and snow on slopes are not in here: the fragment adds
 * those itself as the fallback's third candidate, on thermal height.
 *
 * - tundra (`LandCoverClassifier.ts`, the tundra partition): turf 0.56,
 *   heath 0.24, dry grass 0.11, scree 0.09 at moisture 0.5.
 * - desert (the dry-province terms): straw 55%, sage 26%, rock 10%, sand 8%;
 *   the remainder is grass.
 * - parkland: golden grass under open-grown oaks, straw with the grass that
 *   survives in the wetter hollows.
 */
export const PROVINCE_FAR_SWARD_MIXES: Readonly<Record<"tundra" | "arid" | "parkland", SwardMix>> =
  Object.freeze({
    tundra: Object.freeze({
      [SurfaceMaterial.Grass]: 0.56,
      [SurfaceMaterial.Shrub]: 0.24,
      [SurfaceMaterial.DryGrass]: 0.11,
      [SurfaceMaterial.Gravel]: 0.09,
    }),
    arid: Object.freeze({
      [SurfaceMaterial.DryGrass]: 0.55,
      [SurfaceMaterial.Shrub]: 0.26,
      [SurfaceMaterial.Rock]: 0.1,
      [SurfaceMaterial.Sand]: 0.08,
      [SurfaceMaterial.Grass]: 0.01,
    }),
    parkland: Object.freeze({
      [SurfaceMaterial.DryGrass]: 0.7,
      [SurfaceMaterial.Grass]: 0.3,
    }),
  });

/**
 * The province's drawn crowns over the temperate drawn crowns, per channel:
 * what the canopy paint (`CANOPY_SURFACE_ALBEDO`) would be multiplied by so the
 * step at the handoff ring is the temperate one in every province.
 *
 * MEASURED, not chosen (2026-10-24): crown-area-weighted mean of impostor
 * albedo x per-instance tint over the trees `generateDetailCell` grows in 48
 * cells of a forced province, over the same for the temperate one, on the
 * reference day, for two seeds (open-skies, phase1-perf-baseline):
 *
 * - boreal (by crown area spruce 46-52%, pine 32-36%, birch 16-18%: the cold
 *   thread's darker, bluer conifer tints and 25% wider conifer crowns):
 *   0.64/0.59, 0.83/0.80, 0.94/0.93.
 * - arid (pinyon 70-73%, juniper 25-27%): 0.63/0.61, 0.81/0.80, 0.88/0.87.
 * - parkland (oak 90%): 1.07/1.03, 0.98/0.97, 0.99/0.98.
 * - tropical (oak 44%, maple 33%, birch 12-13%, palm 10-11%: the tropical
 *   thread's greener broadleaf tints): 0.95/0.92, 1.08/1.07, 1.04/1.04.
 *
 * The constants are the means; `tests/render.webgpu-province-far-tone.test.ts`
 * re-measures them on a smaller sample, so a change to a biome's species table
 * or tints that moves its crowns fails there instead of reopening the ring.
 *
 * The paint applies ONE of them (`PROVINCE_FAR_CANOPY_PAINT_RATIO`), weighted
 * by the boreal and arid shares, for the lane reason above: arid's crowns sit
 * within 6% of boreal's in every channel, and parkland's +5% red is left out,
 * since an oak savanna's lone trees close so little canopy that the paint
 * barely shows there. The tropical crowns lean the other way from boreal's
 * (greener, not darker), so no share of that ratio can carry them: they get
 * their own, on the negative half of the same lane.
 */
export const PROVINCE_FAR_CANOPY_RATIOS: Readonly<
  Record<"boreal" | "arid" | "parkland" | "tropical", readonly [number, number, number]>
> = Object.freeze({
  boreal: Object.freeze([0.613, 0.818, 0.93] as const),
  arid: Object.freeze([0.618, 0.8, 0.875] as const),
  parkland: Object.freeze([1.048, 0.974, 0.986] as const),
  tropical: Object.freeze([0.933, 1.073, 1.045] as const),
});

/** Linear albedo of a sward mix, from the materials' reference albedos. */
export function swardMixAlbedo(mix: SwardMix): [number, number, number] {
  const out: [number, number, number] = [0, 0, 0];
  let total = 0;
  for (const [id, share] of Object.entries(mix)) {
    const albedo = surfaceMaterialSpec(Number(id) as SurfaceMaterialId).referenceAlbedo;
    for (let channel = 0; channel < 3; channel += 1) out[channel]! += albedo[channel]! * share!;
    total += share!;
  }
  for (let channel = 0; channel < 3; channel += 1) out[channel]! /= total;
  return out;
}

function deltaOver(
  target: readonly [number, number, number],
  reference: readonly [number, number, number],
): readonly [number, number, number] {
  return Object.freeze([
    target[0] / reference[0] - 1,
    target[1] / reference[1] - 1,
    target[2] / reference[2] - 1,
  ] as const);
}

const GRASS_ALBEDO = surfaceMaterialSpec(SurfaceMaterial.Grass).referenceAlbedo;

/**
 * Base-tone deltas over Grass, per province share, and for a sand sea: the
 * dune stage's pages paint the Sand material over an erg, so its far ground is
 * Sand's reference albedo exactly.
 */
export const PROVINCE_FAR_BASE_DELTAS = Object.freeze({
  tundra: deltaOver(swardMixAlbedo(PROVINCE_FAR_SWARD_MIXES.tundra), GRASS_ALBEDO),
  arid: deltaOver(swardMixAlbedo(PROVINCE_FAR_SWARD_MIXES.arid), GRASS_ALBEDO),
  parkland: deltaOver(swardMixAlbedo(PROVINCE_FAR_SWARD_MIXES.parkland), GRASS_ALBEDO),
  sand: deltaOver(surfaceMaterialSpec(SurfaceMaterial.Sand).referenceAlbedo, GRASS_ALBEDO),
});

/** The one ratio the canopy paint darkens by, at a canopy share of 1: the taiga's. */
export const PROVINCE_FAR_CANOPY_PAINT_RATIO = PROVINCE_FAR_CANOPY_RATIOS.boreal;
/** Its delta over the temperate paint. */
export const PROVINCE_FAR_CANOPY_PAINT_DELTA = deltaOver(PROVINCE_FAR_CANOPY_PAINT_RATIO, [1, 1, 1]);
/** The ratio a NEGATIVE canopy share of -1 paints: the tropical forest's. */
export const PROVINCE_FAR_CANOPY_TROPICAL_RATIO = PROVINCE_FAR_CANOPY_RATIOS.tropical;
/** Its delta over the temperate paint. */
export const PROVINCE_FAR_CANOPY_TROPICAL_DELTA = deltaOver(PROVINCE_FAR_CANOPY_TROPICAL_RATIO, [1, 1, 1]);

/** Thermal height per unit of temperature offset, and the snowline's share of it. */
export const PROVINCE_FAR_LIFT_METERS_PER_TEMPERATURE = CLIMATE_PROVINCE_METERS_PER_TEMPERATURE;
export const PROVINCE_FAR_SNOWLINE_RESPONSE = CLIMATE_PROVINCE_SNOWLINE_RESPONSE;
/**
 * The tundra partition's flat-rock loss (`LandCoverClassifier.ts`,
 * `TUNDRA_FLAT_ROCK_LOSS`), restated for the fallback's LEVEL rock share: the
 * classifier stops calling flat arctic ground bedrock, so the fallback's stand-in
 * must stop too, or the tundra is green up close and grey from 10 km.
 */
export const PROVINCE_FAR_TUNDRA_LEVEL_ROCK_LOSS = 0.6;

export interface ProvinceFarTone {
  /** Metres thermal height adds to real height; the snowline reads `x 0.4` of it. */
  thermalLiftMeters: number;
  base: [number, number, number];
  /**
   * -1..1: above 0 the paint's share of `PROVINCE_FAR_CANOPY_PAINT_DELTA`,
   * below 0 (negated) its share of `PROVINCE_FAR_CANOPY_TROPICAL_DELTA`.
   */
  canopyShare: number;
  /** The canopy paint's per-channel delta that share makes (for audits). */
  canopy: [number, number, number];
}

/**
 * CPU twin of the vertex stage's `terrainProvinceFarTone`. `sand` is the far
 * field's sand lane (a sand sea's erg weight): it takes the base over from the
 * province's sward, since an erg is sand whatever the province around it grows.
 */
export function provinceFarTone(
  temperatureOffset: number,
  dryness: number,
  target: ProvinceFarTone = {
    thermalLiftMeters: 0, base: [0, 0, 0], canopyShare: 0, canopy: [0, 0, 0],
  },
  sand = 0,
): ProvinceFarTone {
  const boreal = borealShare(temperatureOffset);
  const tundra = tundraShare(temperatureOffset);
  const { arid, parkland } = dryProvinceShares(dryness);
  const baseScale = 1 / Math.max(1, tundra + arid + parkland);
  const b = PROVINCE_FAR_BASE_DELTAS;
  const erg = Math.min(1, Math.max(0, sand));
  target.canopyShare = (boreal + arid) / Math.max(1, boreal + arid + parkland)
    - tropicalCoastWeight(temperatureOffset, dryness);
  const darker = Math.max(target.canopyShare, 0);
  const greener = Math.max(-target.canopyShare, 0);
  for (let channel = 0; channel < 3; channel += 1) {
    const sward = (tundra * b.tundra[channel]! + arid * b.arid[channel]!
      + parkland * b.parkland[channel]!) * baseScale;
    target.base[channel] = sward + (b.sand[channel]! - sward) * erg;
    target.canopy[channel] = darker * PROVINCE_FAR_CANOPY_PAINT_DELTA[channel]!
      + greener * PROVINCE_FAR_CANOPY_TROPICAL_DELTA[channel]!;
  }
  target.thermalLiftMeters = -temperatureOffset * PROVINCE_FAR_LIFT_METERS_PER_TEMPERATURE;
  return target;
}

/** The tundra share as the fragment recovers it from the thermal lift alone. */
export function provinceFarTundraFromLift(thermalLiftMeters: number): number {
  return smoothstep(
    TUNDRA_COLD_ONSET * PROVINCE_FAR_LIFT_METERS_PER_TEMPERATURE,
    TUNDRA_COLD_FULL * PROVINCE_FAR_LIFT_METERS_PER_TEMPERATURE,
    thermalLiftMeters,
  );
}

function wgslFloat(value: number): string {
  if (!Number.isFinite(value)) throw new RangeError("WGSL constants must be finite");
  const text = String(Number(value.toPrecision(9)));
  return /[.e]/u.test(text) ? text : `${text}.0`;
}

function wgslVec3(value: readonly [number, number, number]): string {
  return `vec3f(${value.map(wgslFloat).join(", ")})`;
}

/**
 * The vertex stage's half. Requires nothing but WGSL builtins; every
 * identifier carries the `terrainProvince` prefix. The fragment applies the
 * signed canopy share as `max(share, 0) * TERRAIN_PROVINCE_CANOPY_DELTA_WGSL +
 * max(-share, 0) * TERRAIN_PROVINCE_TROPICAL_CANOPY_DELTA_WGSL`.
 */
export const TERRAIN_PROVINCE_FAR_TONE_WGSL = /* wgsl */ `
struct TerrainProvinceFarTone {
  base: vec3f,
  canopyShare: f32,
  thermalLift: f32,
};

fn terrainProvinceFarTone(province: vec3f) -> TerrainProvinceFarTone {
  let boreal = smoothstep(${wgslFloat(BOREAL_COLD_ONSET)}, ${wgslFloat(BOREAL_COLD_FULL)}, -province.x);
  let tundra = smoothstep(${wgslFloat(TUNDRA_COLD_ONSET)}, ${wgslFloat(TUNDRA_COLD_FULL)}, -province.x);
  let arid = smoothstep(
    ${wgslFloat(DRY_PROVINCE_DESERT_ONSET)}, ${wgslFloat(DRY_PROVINCE_DESERT_FULL)}, province.y);
  let parkland = smoothstep(
    ${wgslFloat(DRY_PROVINCE_PARKLAND_ONSET)}, ${wgslFloat(DRY_PROVINCE_PARKLAND_FULL)}, province.y)
    * (1.0 - arid);
  var tone: TerrainProvinceFarTone;
  let sward = (tundra * ${wgslVec3(PROVINCE_FAR_BASE_DELTAS.tundra)}
    + arid * ${wgslVec3(PROVINCE_FAR_BASE_DELTAS.arid)}
    + parkland * ${wgslVec3(PROVINCE_FAR_BASE_DELTAS.parkland)})
    / max(1.0, tundra + arid + parkland);
  // A sand sea takes the base over from the sward (lane z, the erg weight).
  tone.base = sward + (${wgslVec3(PROVINCE_FAR_BASE_DELTAS.sand)} - sward)
    * clamp(province.z, 0.0, 1.0);
  // tropicalCoast.ts's weight, exactly 0.0 at and below its warm onset.
  let tropical = smoothstep(
    ${wgslFloat(TROPICAL_COAST.temperatureStart)}, ${wgslFloat(TROPICAL_COAST.temperatureFull)}, province.x)
    * (1.0 - smoothstep(
      ${wgslFloat(TROPICAL_COAST.drynessStart)}, ${wgslFloat(TROPICAL_COAST.drynessEnd)}, province.y));
  tone.canopyShare = (boreal + arid) / max(1.0, boreal + arid + parkland) - tropical;
  tone.thermalLift = -province.x * ${wgslFloat(PROVINCE_FAR_LIFT_METERS_PER_TEMPERATURE)};
  return tone;
}
`;

/** `PROVINCE_FAR_CANOPY_PAINT_DELTA` as a WGSL literal, for the fragment. */
export const TERRAIN_PROVINCE_CANOPY_DELTA_WGSL = wgslVec3(PROVINCE_FAR_CANOPY_PAINT_DELTA);
/** `PROVINCE_FAR_CANOPY_TROPICAL_DELTA` as a WGSL literal, for the fragment. */
export const TERRAIN_PROVINCE_TROPICAL_CANOPY_DELTA_WGSL = wgslVec3(PROVINCE_FAR_CANOPY_TROPICAL_DELTA);

/** The canopy paint the far fallback uses at a province, for tests and audits. */
export function provinceFarCanopyAlbedo(temperatureOffset: number, dryness: number): [number, number, number] {
  const tone = provinceFarTone(temperatureOffset, dryness);
  return [0, 1, 2].map((channel) =>
    CANOPY_SURFACE_ALBEDO[channel]! * (1 + tone.canopy[channel]!)) as [number, number, number];
}
