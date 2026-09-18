/**
 * `W-8` — WHAT IS IN THE WATER, which is the only thing that decides what
 * colour it is.
 *
 * `W-7` gave every water body a pair of spectra (absorption `a` and
 * backscatter `b_b`) and derived its colour from them, but bound ONE type to
 * every sea, lake and river in the world. This module is where a type comes
 * from: the four things natural water actually carries, and the published
 * mass-specific spectra that turn a concentration into an optical property.
 *
 *   chlorophyll  phytoplankton, mg/m^3 — absorbs blue and red, scatters a
 *                little; the difference between open-ocean indigo (0.05) and
 *                a green productive shelf (3) or a summer-bloom pond (25).
 *   cdom440      coloured dissolved organic matter ("yellow substance"),
 *                1/m at 440 nm — peat and leaf litter leached out of a
 *                catchment. Absorbs blue ferociously and scatters NOTHING,
 *                which is why a forest tarn is tea-brown and a blackwater
 *                river is nearly black.
 *   sediment     suspended organic/mineral particles, g/m^3 — river mud and
 *                resuspended shelf sand. Scatters hard across the spectrum
 *                and absorbs toward blue: the brown-ochre of a flooding river.
 *   mineral      glacial rock flour, g/m^3 — the special case that makes an
 *                alpine lake turquoise: it scatters as hard as mud but barely
 *                absorbs, so the water goes bright while keeping the blue-green
 *                of the water itself.
 *
 * Every coefficient below is a published mass-specific spectrum band-averaged
 * over the renderer's linear-sRGB primaries (620/550/460 nm), and the model is
 * validated in `tests/render.webgpu-water-constituents.test.ts` against
 * measured water types: it reproduces clear ocean, green coastal water, a
 * glacial lake, a humic lake and a muddy river to within a few per cent of
 * their published subsurface reflectances.
 *
 * The same function runs on the CPU (for the lake/river chemistry baked at
 * mesh build and the ocean's environment field) and in WGSL (for the ocean's
 * per-pixel depth terms), from one text.
 */

import type { WaterOpticalType } from "./WaterShaders";
import {
  WATER_PURE_ABSORPTION_PER_METER,
  WATER_PURE_BACKSCATTER_PER_METER,
} from "./WaterShaders";

/** The four concentrations a water type is made of. */
export interface WaterConstituents {
  /** Chlorophyll a, mg/m^3. */
  readonly chlorophyll: number;
  /** CDOM absorption at 440 nm, 1/m. */
  readonly cdom440: number;
  /** Suspended sediment (absorbing particles), g/m^3. */
  readonly sediment: number;
  /** Glacial rock flour (scattering, barely absorbing particles), g/m^3. */
  readonly mineral: number;
}

/**
 * Bricaud et al. (1995/1998) chlorophyll-specific absorption `a_ph = A Chl^E`,
 * band-averaged. One exponent for all three channels (the published 0.63-0.75
 * spread is inside the band averaging's own error) so the shader pays ONE
 * pow() per pixel rather than three.
 */
export const WATER_PHYTOPLANKTON_ABSORPTION = Object.freeze([0.0090, 0.0068, 0.0335] as const);
export const WATER_PHYTOPLANKTON_EXPONENT = 0.7;
/** Chlorophyll-specific backscatter at 550 nm with a 1/lambda shape. */
export const WATER_PHYTOPLANKTON_BACKSCATTER = Object.freeze([0.00062, 0.0007, 0.00084] as const);

/**
 * CDOM's exponential spectrum `exp(-S (lambda - 440))` with the standard
 * S = 0.017 /nm, evaluated at the three band centres. Blue is hit 15x harder
 * than red, which is the whole look of a peat-stained water.
 */
export const WATER_CDOM_SPECTRUM = Object.freeze([0.047, 0.154, 0.71] as const);

/**
 * Non-algal particles: absorption `a_nap(440) = 0.031 per (g/m^3)` with the
 * flatter `exp(-0.0123 (lambda - 440))` slope, and Babin's mineral-specific
 * backscatter 0.0121 m^2/g at 650 nm with a mild `lambda^-0.5` shape.
 */
export const WATER_SEDIMENT_ABSORPTION_440 = 0.031;
export const WATER_SEDIMENT_ABSORPTION_SPECTRUM = Object.freeze([0.108, 0.258, 0.78] as const);
export const WATER_SEDIMENT_BACKSCATTER = Object.freeze([0.0113, 0.0120, 0.0131] as const);

/**
 * Glacial flour is the same backscatter with a SIXTH of the absorption:
 * ground rock is close to white, which is exactly why a glacier-fed lake is
 * bright turquoise instead of brown.
 */
export const WATER_MINERAL_ABSORPTION_440 = 0.005;
export const WATER_MINERAL_BACKSCATTER = Object.freeze([0.0125, 0.0130, 0.0137] as const);

/** Clamps a concentration into the range the model is calibrated over. */
function concentration(value: number, maximum: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError("Water constituent concentrations must be finite and non-negative");
  }
  return Math.min(value, maximum);
}

export const WATER_MAX_CHLOROPHYLL = 60;
export const WATER_MAX_CDOM = 12;
export const WATER_MAX_SEDIMENT = 400;
export const WATER_MAX_MINERAL = 60;

/**
 * The model, on the CPU: concentrations to inherent optical properties. The
 * WGSL twin below is the same arithmetic in the same order.
 */
export function waterOpticsFromConstituents(
  constituents: WaterConstituents,
): WaterOpticalType {
  const chlorophyll = concentration(constituents.chlorophyll, WATER_MAX_CHLOROPHYLL);
  const cdom440 = concentration(constituents.cdom440, WATER_MAX_CDOM);
  const sediment = concentration(constituents.sediment, WATER_MAX_SEDIMENT);
  const mineral = concentration(constituents.mineral, WATER_MAX_MINERAL);
  const pigment = chlorophyll ** WATER_PHYTOPLANKTON_EXPONENT;
  const absorption: [number, number, number] = [0, 0, 0];
  const backscatter: [number, number, number] = [0, 0, 0];
  for (let channel = 0; channel < 3; channel += 1) {
    absorption[channel] = WATER_PURE_ABSORPTION_PER_METER[channel]!
      + WATER_PHYTOPLANKTON_ABSORPTION[channel]! * pigment
      + WATER_CDOM_SPECTRUM[channel]! * cdom440
      + WATER_SEDIMENT_ABSORPTION_SPECTRUM[channel]!
        * WATER_SEDIMENT_ABSORPTION_440 * sediment
      + WATER_SEDIMENT_ABSORPTION_SPECTRUM[channel]!
        * WATER_MINERAL_ABSORPTION_440 * mineral;
    backscatter[channel] = WATER_PURE_BACKSCATTER_PER_METER[channel]!
      + WATER_PHYTOPLANKTON_BACKSCATTER[channel]! * pigment
      + WATER_SEDIMENT_BACKSCATTER[channel]! * sediment
      + WATER_MINERAL_BACKSCATTER[channel]! * mineral;
  }
  return {
    absorptionPerMeter: Object.freeze(absorption) as unknown as readonly [number, number, number],
    backscatterPerMeter: Object.freeze(backscatter) as unknown as readonly [number, number, number],
  };
}

/** The WGSL twin, composed into both water fragments. */
export const WATER_CONSTITUENT_WGSL = /* wgsl */ `
// W-8: the four concentrations a water type is made of.
struct WaterConstituents {
  chlorophyll: f32,
  cdom440: f32,
  sediment: f32,
  mineral: f32,
}

const WATER_PHYTOPLANKTON_ABSORPTION = vec3f(${WATER_PHYTOPLANKTON_ABSORPTION.join(", ")});
const WATER_PHYTOPLANKTON_BACKSCATTER = vec3f(${WATER_PHYTOPLANKTON_BACKSCATTER.join(", ")});
const WATER_CDOM_SPECTRUM = vec3f(${WATER_CDOM_SPECTRUM.join(", ")});
const WATER_SEDIMENT_ABSORPTION_SPECTRUM = vec3f(${WATER_SEDIMENT_ABSORPTION_SPECTRUM.join(", ")});
const WATER_SEDIMENT_BACKSCATTER = vec3f(${WATER_SEDIMENT_BACKSCATTER.join(", ")});
const WATER_MINERAL_BACKSCATTER = vec3f(${WATER_MINERAL_BACKSCATTER.join(", ")});
const WATER_PURE_ABSORPTION = vec3f(${WATER_PURE_ABSORPTION_PER_METER.join(", ")});
const WATER_PURE_BACKSCATTER = vec3f(${WATER_PURE_BACKSCATTER_PER_METER.join(", ")});

// One transcendental for the pigment term, then two multiply-adds per
// constituent: the whole per-pixel cost of giving every water body in the
// world its own colour.
fn waterOpticsFromConstituents(constituents: WaterConstituents) -> WaterOptics {
  let chlorophyll = clamp(constituents.chlorophyll, 0.0, ${WATER_MAX_CHLOROPHYLL.toFixed(1)});
  let cdom440 = clamp(constituents.cdom440, 0.0, ${WATER_MAX_CDOM.toFixed(1)});
  let sediment = clamp(constituents.sediment, 0.0, ${WATER_MAX_SEDIMENT.toFixed(1)});
  let mineral = clamp(constituents.mineral, 0.0, ${WATER_MAX_MINERAL.toFixed(1)});
  let pigment = pow(chlorophyll, ${WATER_PHYTOPLANKTON_EXPONENT.toFixed(2)});
  let absorption = WATER_PURE_ABSORPTION
    + WATER_PHYTOPLANKTON_ABSORPTION * pigment
    + WATER_CDOM_SPECTRUM * cdom440
    + WATER_SEDIMENT_ABSORPTION_SPECTRUM
      * (${WATER_SEDIMENT_ABSORPTION_440.toFixed(4)} * sediment
        + ${WATER_MINERAL_ABSORPTION_440.toFixed(4)} * mineral);
  let backscatter = WATER_PURE_BACKSCATTER
    + WATER_PHYTOPLANKTON_BACKSCATTER * pigment
    + WATER_SEDIMENT_BACKSCATTER * sediment
    + WATER_MINERAL_BACKSCATTER * mineral;
  return WaterOptics(absorption, backscatter);
}
`;

/**
 * `W-8` — the OCEAN's own chemistry, as a function of the two things a sea
 * pixel can know cheaply: how deep the water is (the shelf gradient) and what
 * province of the world it is in (the baked environment field).
 *
 * Case 1 water (the open ocean) is chlorophyll and nothing else; Case 2 water
 * (a shelf, an estuary, a surf zone) adds the land's runoff and whatever the
 * waves lift off the bottom. Depth alone carries most of that: this world's
 * sea bed reaches only ~110 m, so the shelf IS the coast, and the same
 * smoothstep that turns indigo into green also turns it into the pale
 * turquoise of a sand flat as the bed comes up.
 */
export const OCEAN_OPEN_CHLOROPHYLL = 0.06;
export const OCEAN_COASTAL_CHLOROPHYLL = 1.6;
export const OCEAN_OPEN_CDOM = 0.012;
export const OCEAN_COASTAL_CDOM = 0.22;
export const OCEAN_COASTAL_SEDIMENT = 2.2;
export const OCEAN_SURF_SEDIMENT = 5.5;

/**
 * `W-8c` — the CONTRAST CURVE on the province index, and the one place in this
 * wave that is world design rather than physics.
 *
 * The index is an invented productivity field, not a measurement, and near the
 * spawn it only spans 0.26 to 0.74. Run linearly into the concentrations, that
 * put the driest and the wettest coast in the world within a colorimeter's
 * reach of each other — true to the field, useless as an answer to "the colour
 * is always the same". This smoothstep re-shapes the INDEX (never the optics):
 * 0.26 becomes 0.04 and 0.74 becomes 0.97, while 0.5 maps to 0.5 exactly, so
 * the middle of the world — which is where every gated capture sits — is
 * untouched by construction.
 */
export const OCEAN_PROVINCE_CONTRAST_LOW = 0.18;
export const OCEAN_PROVINCE_CONTRAST_HIGH = 0.82;

/**
 * `W-8c` — resuspended sediment is what the LAND sheds, so the load follows
 * the province's runoff.
 *
 * Before this, every shallow coast in the world carried the same ~7.7 g/m^3 of
 * surf-zone and shelf sediment, which is why no sea bed ever read through
 * anywhere: the water was milky green over pale sand and dark silt alike. An
 * arid carbonate coast has clear water over a bright bed and a rain-fed silty
 * one is turbid, and that difference is most of what "this coast looks
 * different" means from the air. `0.4 + 2.4 r^2` is exactly 1.0 at
 * mid-province, so the world's mean turbidity is unchanged and only its spread
 * grows — 6.6x from the driest coast to the wettest.
 */
export const OCEAN_SEDIMENT_LOAD_BASE = 0.4;
export const OCEAN_SEDIMENT_LOAD_RUNOFF = 2.4;
/** Depths (m) over which the shelf hands over to open water, and to the surf. */
export const OCEAN_COASTAL_DEPTH_NEAR = 22;
export const OCEAN_COASTAL_DEPTH_FAR = 130;
export const OCEAN_SURF_DEPTH_NEAR = 1.5;
export const OCEAN_SURF_DEPTH_FAR = 14;

/**
 * `W-8` — INLAND chemistry, resolved once per lake or per river station at
 * mesh build and carried as a vertex attribute.
 *
 * Both resolvers are PURE FUNCTIONS OF WORLD POSITION and of the water body's
 * own measured attributes, with no page, region or neighbour state, so the two
 * sides of a page seam derive the same numbers by construction — the
 * continuity rule the hydrology paging needs.
 */
export interface InlandWaterEnvironment {
  /** Water-surface elevation above sea level, metres. */
  readonly elevationAboveSeaMeters: number;
  /** Terrain temperature field at the water, 0..1 (1 unit = 15.9 K). */
  readonly temperature: number;
  /** Terrain moisture field at the water, 0..1. */
  readonly moisture: number;
}

/** Glacial flour needs cold AND height: a valley glacier's outwash. */
export const LAKE_GLACIAL_TEMPERATURE_COLD = 0.20;
export const LAKE_GLACIAL_TEMPERATURE_MILD = 0.40;
export const LAKE_GLACIAL_ELEVATION_LOW = 550;
export const LAKE_GLACIAL_ELEVATION_HIGH = 1400;
export const LAKE_GLACIAL_MINERAL = 9;

/**
 * Resolve a lake's chemistry. Three regimes, blended rather than switched:
 * glacial (cold and high: rock flour, turquoise), humic (wet and vegetated:
 * CDOM, tea-brown), and productive (warm, wet, low: chlorophyll, green). A
 * deep lake is clearer than a shallow one of the same catchment because its
 * volume dilutes the same inflow.
 */
export function resolveLakeConstituents(
  environment: InlandWaterEnvironment,
  maximumDepthMeters: number,
  areaSquareMeters: number,
): WaterConstituents {
  const { elevationAboveSeaMeters, temperature, moisture } = environment;
  const glacial = smoothstepDown(LAKE_GLACIAL_TEMPERATURE_COLD, LAKE_GLACIAL_TEMPERATURE_MILD, temperature)
    * smoothstepUp(LAKE_GLACIAL_ELEVATION_LOW, LAKE_GLACIAL_ELEVATION_HIGH, elevationAboveSeaMeters);
  // Volume dilutes: a 40 m deep, 2 km wide lake carries a fraction of the
  // stain a 3 m pond in the same forest does.
  const dilution = 1 / (1 + Math.max(maximumDepthMeters, 0) / 14
    + Math.sqrt(Math.max(areaSquareMeters, 0)) / 4_000);
  const wet = smoothstepUp(0.42, 0.86, moisture);
  const warm = smoothstepUp(0.34, 0.72, temperature);
  const humic = wet * (1 - glacial) * dilution;
  const productive = warm * wet * (1 - glacial) * dilution;
  return {
    chlorophyll: 0.35 + 22 * productive,
    cdom440: 0.05 + 3.2 * humic,
    sediment: 0.15 + 1.6 * productive,
    mineral: LAKE_GLACIAL_MINERAL * glacial,
  };
}

/**
 * Resolve a river station's chemistry. A river is its catchment in suspension:
 * steep cold headwaters run clear or milky, and the same water 40 km
 * downstream — wider, slower, draining wet ground — runs green-brown with
 * whatever the banks gave it. Sediment follows stream power (discharge times
 * grade) because that is what lifts it.
 */
export function resolveRiverConstituents(
  environment: InlandWaterEnvironment,
  widthMeters: number,
  flowSpeedMetersPerSecond: number,
  gradeRiseOverRun: number,
): WaterConstituents {
  const { elevationAboveSeaMeters, temperature, moisture } = environment;
  const glacial = smoothstepDown(LAKE_GLACIAL_TEMPERATURE_COLD, LAKE_GLACIAL_TEMPERATURE_MILD, temperature)
    * smoothstepUp(LAKE_GLACIAL_ELEVATION_LOW, LAKE_GLACIAL_ELEVATION_HIGH, elevationAboveSeaMeters);
  // Stream power: the discharge proxy is the channel's own width times its
  // speed, and the grade is what turns that into suspended load.
  const streamPower = Math.max(widthMeters, 0) * Math.max(flowSpeedMetersPerSecond, 0)
    * Math.min(Math.max(gradeRiseOverRun, 0), 0.08);
  const load = smoothstepUp(0.08, 2.5, streamPower);
  const wet = smoothstepUp(0.42, 0.86, moisture);
  const lowland = smoothstepDown(80, 900, elevationAboveSeaMeters);
  return {
    chlorophyll: 0.2 + 4 * lowland * wet * (1 - glacial),
    cdom440: 0.04 + 2.4 * wet * lowland * (1 - glacial),
    sediment: 0.3 + 34 * load * lowland,
    mineral: 7 * glacial,
  };
}

function smoothstepUp(low: number, high: number, value: number): number {
  if (!(high > low)) throw new RangeError("smoothstep edges must increase");
  const t = Math.min(Math.max((value - low) / (high - low), 0), 1);
  return t * t * (3 - 2 * t);
}

function smoothstepDown(low: number, high: number, value: number): number {
  return 1 - smoothstepUp(low, high, value);
}
