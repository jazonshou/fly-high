import { fbm2D, smoothstep } from "./noise";
import { mixSeed } from "./seed";
import type { WorldDefinition } from "./types";

/**
 * Climate provinces: two very slow offsets on the climate chain, one for
 * temperature and one for dryness.
 *
 * Until this file the whole world was one temperate climate. Latitude moved the
 * seasons, the 11 km `climate` field and the rain-shadow moisture fields moved
 * the local mix, and every place still read as the same meadow, forest and
 * mountain. The provinces change the INPUTS of that chain rather than its
 * outputs, so everything that already reads climate (the land-cover
 * classifier, the density field, tree and shrub species, river width, lake
 * chemistry) follows without a rule of its own.
 *
 * TWO OFFSETS, IN THE UNITS OF THE FIELDS THEY MOVE.
 *
 * - `temperatureOffset` is in normalised temperature units, the units of
 *   `terrainTemperatureFromClimate`: one unit is 2,450 m of lapse, or 15.9 K.
 *   Negative is colder. It is added to the temperature, and it also lifts the
 *   classifier's and the density field's altitude bands through "thermal
 *   height" (`terrainThermalHeight`): a cold province at sea level behaves like
 *   today's ground that much higher up.
 * - `dryness` is a FRACTION of the moisture axis, applied by
 *   `applyClimateProvinceDryness`: positive removes that share of the moisture
 *   (`m * (1 - dryness)`), negative fills that share of the remaining dryness
 *   (`m + (1 - m) * -dryness`). Scaling rather than subtracting keeps the
 *   850 m and 5.2 km moisture structure alive in a desert: subtract-and-clamp
 *   sends most of an arid province to one moisture value, 0, and leaves the
 *   classifier and the density field nothing to choose between sagebrush, bare
 *   sand and gravel with.
 *
 * THE TEMPERATE CORE. Both offsets are multiplied by a mask that is EXACTLY 0
 * within `CLIMATE_PROVINCE.coreRadiusMeters` of the start airport, and every
 * consumer adds them as `x + 0` or subtracts them as `x - 0`, which IEEE leaves
 * bit-identical. Every perf baseline sits within about 20 km of the airport and
 * the far plane is 45 km, so a 70 km core keeps all of them pixel-identical.
 * The mask reaches full strength over the following
 * `CLIMATE_PROVINCE.rampMeters`.
 *
 * PROVINCES, NOT GRADIENTS. Each offset is a soft staircase over a 2-octave
 * field: plateaus at the `levels` below, joined by ecotones about 12 km
 * wide where the field crosses a threshold. The thresholds sit at measured
 * quantiles of the field, so each plateau covers a chosen share of the world
 * rather than whatever share a linear map happens to give the middle. The two
 * fields are independent, so every pairing occurs: cold and wet, cold and dry,
 * hot and wet, hot and dry, which is the shape of a Whittaker diagram.
 *
 * The lattices are slow enough (60 km octaves and up) that no page level
 * filters them, and the GPU twin (`TerrainKernel.ts`) declares them with a
 * zero band-limit override so the province is the same number at every level.
 *
 * Class K: pure arithmetic over numbers, transliterated to WGSL in
 * `TerrainKernel.ts` (`terrainClimateProvince`).
 */

export interface ClimateProvinceSample {
  /** Normalised temperature units (1 = 2,450 m of lapse = 15.9 K); negative is colder. */
  temperatureOffset: number;
  /**
   * Share of the moisture axis removed (positive, drier) or filled (negative,
   * wetter); see `applyClimateProvinceDryness`. In [-1, 1].
   */
  dryness: number;
}

/**
 * Named provinces for the force-province world option.
 *
 * Each biome's own work owns its row. The natural field's plateaus are the
 * same numbers (see `CLIMATE_PROVINCE.temperatureLevels`), so a forced world
 * looks like the middle of the matching province.
 */
export type ClimateProvinceName =
  | "temperate"
  | "boreal"
  | "tundra"
  | "high-desert"
  | "savanna"
  | "tropical";

export const CLIMATE_PROVINCE_PRESETS: Readonly<
  Record<ClimateProvinceName, Readonly<ClimateProvinceSample>>
> = Object.freeze({
  temperate: Object.freeze({ temperatureOffset: 0, dryness: 0 }),
  boreal: Object.freeze({ temperatureOffset: -0.22, dryness: 0 }),
  tundra: Object.freeze({ temperatureOffset: -0.55, dryness: 0 }),
  "high-desert": Object.freeze({ temperatureOffset: 0, dryness: 0.5 }),
  savanna: Object.freeze({ temperatureOffset: 0.12, dryness: 0.25 }),
  tropical: Object.freeze({ temperatureOffset: 0.28, dryness: -0.15 }),
});

export const CLIMATE_PROVINCE_NAMES = Object.freeze(
  Object.keys(CLIMATE_PROVINCE_PRESETS) as ClimateProvinceName[],
);

/** What `WorldOptions.climateProvince` accepts: a preset name or explicit offsets. */
export type ClimateProvinceOption = ClimateProvinceName | Readonly<ClimateProvinceSample>;

/**
 * Metres of thermal height per normalised temperature unit: the same 2,450 m
 * the elevation cooling in `terrainTemperatureFromClimate` and the seasonal
 * snowline descent already use.
 */
export const CLIMATE_PROVINCE_METERS_PER_TEMPERATURE = 2_450;

/**
 * The share of the thermal shift the SNOWLINE follows.
 *
 * Not 1, on purpose. If the treeline and the snowline both read the same
 * thermal height, a cold province lands either in the treeline ecotone or
 * under permanent snow: today trees are gone by about 1,390 m and Snow wins
 * from about 1,430 m, so there is no room for tundra between them. Real arctic
 * tundra exists because it is dry, and the glacier line sits far above the
 * treeline-equivalent. The snowline therefore follows only part of the shift.
 * The cold-biome work owns this number.
 */
export const CLIMATE_PROVINCE_SNOWLINE_RESPONSE = 0.4;

/** Snowline metres per normalised temperature unit; one product, shared with WGSL. */
export const CLIMATE_PROVINCE_SNOWLINE_METERS_PER_TEMPERATURE =
  CLIMATE_PROVINCE_METERS_PER_TEMPERATURE * CLIMATE_PROVINCE_SNOWLINE_RESPONSE;

export const CLIMATE_PROVINCE = Object.freeze({
  /** Offsets are exactly 0 within this distance of the start airport. */
  coreRadiusMeters: 70_000,
  /** Distance past the core over which the offsets ramp to full strength. */
  rampMeters: 30_000,
  temperature: Object.freeze({
    channel: 212,
    octaves: 2,
    baseWavelengthMeters: 150_000,
    lacunarity: 2,
    persistence: 0.5,
    /**
     * Plateaus, coldest first: tundra, boreal, temperate, warm, hot. The
     * same values as the named presets.
     */
    levels: Object.freeze([-0.55, -0.22, 0, 0.12, 0.28]),
    /**
     * Field values at which the staircase steps, at the field's measured
     * 15 / 35 / 65 / 85 % quantiles (five seeds, 800k samples): tundra 15 %, boreal 20 %, temperate 30 %,
     * warm 20 %, hot 15 % of province ground.
     */
    thresholds: Object.freeze([-0.37, -0.145, 0.145, 0.37]),
  }),
  dryness: Object.freeze({
    channel: 213,
    octaves: 2,
    baseWavelengthMeters: 120_000,
    lacunarity: 2,
    persistence: 0.5,
    /** Plateaus, wettest first: wet, ordinary, semi-arid, arid. */
    levels: Object.freeze([-0.15, 0, 0.25, 0.5]),
    /** At the 20 / 55 / 80 % quantiles: wet 20 %, ordinary 35 %, semi-arid 25 %, arid 20 %. */
    thresholds: Object.freeze([-0.305, 0.045, 0.3]),
  }),
  /**
   * Half-width of each step, in field units. The fields' median gradient is
   * 6-7e-6 per metre (measured over five seeds), so an ecotone is about 11-13 km
   * wide: a minute and a half at jet cruise.
   */
  ecotoneHalfWidth: 0.04,
});

/** Validate and freeze a world's forced province. Null keeps the natural field. */
export function resolveClimateProvinceOption(
  option: ClimateProvinceOption | undefined,
): Readonly<ClimateProvinceSample> | null {
  if (option === undefined) return null;
  if (typeof option === "string") {
    const preset = CLIMATE_PROVINCE_PRESETS[option];
    if (!preset) {
      throw new RangeError(
        `climateProvince must be one of ${CLIMATE_PROVINCE_NAMES.join(", ")}`,
      );
    }
    return preset;
  }
  const { temperatureOffset, dryness } = option;
  if (!Number.isFinite(temperatureOffset) || !Number.isFinite(dryness)) {
    throw new RangeError("climateProvince offsets must be finite");
  }
  if (dryness < -1 || dryness > 1) {
    throw new RangeError("climateProvince dryness must be in [-1, 1]");
  }
  return Object.freeze({ temperatureOffset, dryness });
}

/** The centre of the temperate core: the start airport, or the origin without one. */
export function climateProvinceCoreCenter(
  world: Pick<WorldDefinition, "airport">,
): { readonly x: number; readonly z: number } {
  return world.airport
    ? { x: world.airport.centerX, z: world.airport.centerZ }
    : { x: 0, z: 0 };
}

/** 0 inside the temperate core, exactly; 1 from `coreRadius + ramp` out. */
export function climateProvinceCoreMask(
  world: Pick<WorldDefinition, "airport">,
  x: number,
  z: number,
): number {
  // Inline rather than through `climateProvinceCoreCenter`: every CPU terrain
  // sample comes through here, so it allocates nothing.
  const airport = world.airport;
  return smoothstep(
    CLIMATE_PROVINCE.coreRadiusMeters,
    CLIMATE_PROVINCE.coreRadiusMeters + CLIMATE_PROVINCE.rampMeters,
    Math.hypot(x - (airport ? airport.centerX : 0), z - (airport ? airport.centerZ : 0)),
  );
}

/** A soft staircase: `levels[0]` below the first threshold, one step per threshold. */
export function climateProvinceStaircase(
  value: number,
  levels: readonly number[],
  thresholds: readonly number[],
): number {
  const halfWidth = CLIMATE_PROVINCE.ecotoneHalfWidth;
  let result = levels[0]!;
  for (let step = 0; step < thresholds.length; step += 1) {
    const threshold = thresholds[step]!;
    result += (levels[step + 1]! - levels[step]!)
      * smoothstep(threshold - halfWidth, threshold + halfWidth, value);
  }
  return result;
}

/** The raw 2-octave fields the staircases read, before the core mask. */
export function sampleClimateProvinceFields(
  seedHash: number,
  x: number,
  z: number,
): { readonly temperature: number; readonly dryness: number } {
  const t = CLIMATE_PROVINCE.temperature;
  const d = CLIMATE_PROVINCE.dryness;
  return {
    temperature: fbm2D(
      mixSeed(seedHash, t.channel),
      x / t.baseWavelengthMeters,
      z / t.baseWavelengthMeters,
      t.octaves,
      t.lacunarity,
      t.persistence,
    ),
    dryness: fbm2D(
      mixSeed(seedHash, d.channel),
      x / d.baseWavelengthMeters,
      z / d.baseWavelengthMeters,
      d.octaves,
      d.lacunarity,
      d.persistence,
    ),
  };
}

/**
 * The natural province offsets at a point BEFORE the temperate-core mask: the
 * staircases at full strength. For consumers with a core of their own (the
 * landform work keeps a larger one); everything else reads
 * `sampleClimateProvince`. WGSL twin: `terrainClimateProvinceUnmasked`.
 */
export function sampleClimateProvinceUnmasked(
  seedHash: number,
  x: number,
  z: number,
  target: ClimateProvinceSample = { temperatureOffset: 0, dryness: 0 },
): ClimateProvinceSample {
  // The fields inline rather than through `sampleClimateProvinceFields`, so a
  // caller with a scratch target allocates nothing (CPU samplers run per frame).
  const t = CLIMATE_PROVINCE.temperature;
  const d = CLIMATE_PROVINCE.dryness;
  target.temperatureOffset = climateProvinceStaircase(
    fbm2D(
      mixSeed(seedHash, t.channel),
      x / t.baseWavelengthMeters,
      z / t.baseWavelengthMeters,
      t.octaves,
      t.lacunarity,
      t.persistence,
    ),
    t.levels,
    t.thresholds,
  );
  target.dryness = climateProvinceStaircase(
    fbm2D(
      mixSeed(seedHash, d.channel),
      x / d.baseWavelengthMeters,
      z / d.baseWavelengthMeters,
      d.octaves,
      d.lacunarity,
      d.persistence,
    ),
    d.levels,
    d.thresholds,
  );
  return target;
}

/**
 * The province offsets at a world point. Exactly `{0, 0}` inside the temperate
 * core of a natural world; the forced offsets everywhere in a forced one.
 */
export function sampleClimateProvince(
  world: Pick<WorldDefinition, "airport" | "seedHash" | "climateProvince">,
  x: number,
  z: number,
  target: ClimateProvinceSample = { temperatureOffset: 0, dryness: 0 },
): ClimateProvinceSample {
  const forced = world.climateProvince;
  if (forced) {
    target.temperatureOffset = forced.temperatureOffset;
    target.dryness = forced.dryness;
    return target;
  }
  const mask = climateProvinceCoreMask(world, x, z);
  if (mask <= 0) {
    target.temperatureOffset = 0;
    target.dryness = 0;
    return target;
  }
  sampleClimateProvinceUnmasked(world.seedHash, x, z, target);
  target.temperatureOffset *= mask;
  target.dryness *= mask;
  return target;
}

/**
 * Apply a province's dryness to a moisture-like value in [0, 1]: positive
 * dryness scales it toward 0, negative scales the gap to 1 shut. A zero dryness
 * is `m - 0 * m`, which is `m` bit for bit. The WGSL twin is `kProvinceDryness`.
 */
export function applyClimateProvinceDryness(moisture: number, dryness: number): number {
  return moisture - dryness * (dryness > 0 ? moisture : 1 - moisture);
}

/**
 * Thermal height: the altitude whose climate a point has. `height - offset x
 * 2,450 m`, so a cold (negative) offset lifts it and `offset = 0` returns the
 * height unchanged, bit for bit.
 */
export function terrainThermalHeight(heightMeters: number, temperatureOffset: number): number {
  return heightMeters - temperatureOffset * CLIMATE_PROVINCE_METERS_PER_TEMPERATURE;
}

/** Thermal height for snowline tests: only `CLIMATE_PROVINCE_SNOWLINE_RESPONSE` of the shift. */
export function terrainSnowlineThermalHeight(
  heightMeters: number,
  temperatureOffset: number,
): number {
  return heightMeters - temperatureOffset * CLIMATE_PROVINCE_SNOWLINE_METERS_PER_TEMPERATURE;
}
