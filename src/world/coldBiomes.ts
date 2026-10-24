import { smoothstep } from "./noise";

/**
 * The cold biomes — boreal forest and tundra — as DATA on the climate
 * province's temperature offset (`sampleClimateProvince`, `climateProvince.ts`).
 *
 * The province change (thermal height) already moves everything that is a
 * matter of DEGREE: a cold province lowers the treeline, the alpine bands and
 * the snowline, and its temperature reaches every consumer of the climate
 * chain. What it cannot move is anything that is a matter of KIND — which
 * species stand in a forest, what grows on open ground, what a lake leaches.
 * A temperate forest made colder is a temperate forest at altitude, oak and
 * maple included; a boreal forest is spruce, pine and birch at sea level.
 * These two shares are where that difference is stated, once, for the
 * species, the ground classifier and the water to read.
 *
 * `temperatureOffset` is the province's raw offset: normalised temperature
 * units (1 = 15.9 K = 2,450 m of lapse), negative colder, and EXACTLY 0 inside
 * the temperate core around the start airport.
 *
 * INVARIANT THIS FILE OWNS: both shares are exactly 0 for every offset at or
 * above `-BOREAL_COLD_ONSET`, so every consumer that applies them as
 * `x + share * k`, `x * (1 - share * k)` or a `u < share` split of a uniform
 * draw is bit-identical in the temperate core — and every baseline shot sits
 * inside it. IEEE gives `x + 0 === x`, `x * 1 === x` and
 * `(u - 0) / (1 - 0) === u`, and `smoothstep` saturates to exactly 0 below its
 * lower edge.
 *
 * The two shares are cumulative, not exclusive: `borealShare` reads "at least
 * as cold as boreal" and stays 1 through the tundra, where the few trees left
 * at the treeline are boreal species. `tundraShare` reads "cold enough that
 * open ground is tundra rather than meadow".
 *
 * Calibration against the province presets (thermal height = height -
 * offset x 2,450 m; the snowline follows `CLIMATE_PROVINCE_SNOWLINE_RESPONSE`
 * of that):
 * - boreal, -0.22: +540 m. A sea-level stand sits where the temperate world's
 *   foothills do, well below the 1,350 m treeline, so it is still closed
 *   forest — the species are what change. The share is full from -0.2.
 * - tundra, -0.65: +1,590 m. Sea level is above the ragged treeline (1,350 m,
 *   wandering by up to ~290 m) nearly everywhere; only the most sheltered
 *   sun-facing ground keeps a krummholz stem. The snowline, at 0.4 of the
 *   shift, comes down by 640 m to ~880 m, which leaves the lowland snow-free
 *   in summer and glaciates the hills above it — arctic proportions. The
 *   share is full from -0.62. Between the two, -0.4 to -0.62 is the
 *   forest-tundra: stands thinning out across the treeline.
 *
 * Class P: pure arithmetic, with a WGSL twin for the splat bake.
 */
export const BOREAL_COLD_ONSET = 0.06;
export const BOREAL_COLD_FULL = 0.2;
export const TUNDRA_COLD_ONSET = 0.4;
export const TUNDRA_COLD_FULL = 0.62;

/**
 * The arctic shrub belt: metres of THERMAL height that a full tundra share
 * adds to the density field's shrub line (`densityField`, `shrubTreeline`).
 *
 * A mountain's shrub belt is narrow. Krummholz and dwarf pine give out about
 * 140 m above the treeline, because on a slope a kelvin of cooling is only
 * 150 m away. The arctic's is a whole zone: low shrub tundra (dwarf birch,
 * willow, alder in the gullies) runs hundreds of kilometres poleward of the
 * forest, several kelvin colder than the treeline, before the high arctic's
 * fell field begins. 700 m is about 4.5 K. At the -0.65 plateau the shrubs
 * stand thinly on the lowland and give out near 600 m, which leaves the
 * hills below the ~880 m snowline as bare fell field. Without it the tundra
 * would place no shrub at all: its whole lowland sits above the alpine shrub
 * line. 0 in the temperate core (`+ 0 * k`).
 */
export const TUNDRA_SHRUB_BELT_METERS = 700;

/** 0 in the temperate core, 1 from a full boreal province onward. */
export function borealShare(temperatureOffset: number): number {
  return smoothstep(BOREAL_COLD_ONSET, BOREAL_COLD_FULL, -temperatureOffset);
}

/** 0 until the province is colder than boreal, 1 in full tundra. */
export function tundraShare(temperatureOffset: number): number {
  return smoothstep(TUNDRA_COLD_ONSET, TUNDRA_COLD_FULL, -temperatureOffset);
}

/**
 * Split one uniform draw between the cold and the temperate table.
 *
 * `u < share` picks the cold table and rescales `u / share`; otherwise the
 * temperate table gets `(u - share) / (1 - share)`. Both are uniform on
 * [0, 1), so a stand's dominant choice still decides its whole stand, and an
 * ecotone is a patchwork of boreal and temperate STANDS rather than a
 * salt-and-pepper mix. At share 0 the temperate branch receives `u` itself,
 * bit for bit, and no extra random number is drawn — which is what keeps the
 * core's forests identical. A full share sends every draw to the cold table,
 * including a selector of exactly 1 (`standField` channels are closed on 1).
 */
export function splitColdDraw(
  share: number,
  choice: number,
): { readonly cold: boolean; readonly choice: number } {
  if (share >= 1) return { cold: true, choice };
  if (choice < share) return { cold: true, choice: choice / share };
  return { cold: false, choice: (choice - share) / (1 - share) };
}

/**
 * The WGSL twin of the two shares. Requires `kSmoothstep`. Prefixed `cold`
 * because it is composed into shaders that carry other includes.
 */
export const COLD_BIOME_WGSL = /* wgsl */ `
fn coldBorealShare(temperatureOffset: f32) -> f32 {
  return kSmoothstep(${BOREAL_COLD_ONSET}, ${BOREAL_COLD_FULL}, -temperatureOffset);
}

fn coldTundraShare(temperatureOffset: f32) -> f32 {
  return kSmoothstep(${TUNDRA_COLD_ONSET}, ${TUNDRA_COLD_FULL}, -temperatureOffset);
}
`;
