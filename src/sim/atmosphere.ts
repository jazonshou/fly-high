import { clamp } from "./math";

/**
 * The International Standard Atmosphere, to 32 km.
 *
 * Replaces an exponential with an 8,500 m scale height that was "sufficient at
 * the light trainer's envelope" and was then asked to carry three jets. Against
 * ISA it read 5% thin at 3,000 m, 9% thin at 9,000 m and 8% THICK at 15,000 m,
 * where the Global and the F-16 live. And it stopped at 20 km: above that the
 * air never got thinner, so any aeroplane that reached it had no ceiling at
 * all. Speed of sound came from the troposphere's density-temperature relation
 * applied everywhere, which put it 6% low at 15 km, and with it every Mach the
 * wave drag and the engines read.
 *
 * The layers are the standard's own: a 6.5 K/km lapse to the tropopause at
 * 11 km, isothermal at 216.65 K to 20 km, then warming at 1 K/km.
 */

export const SEA_LEVEL_DENSITY = 1.225;
export const SEA_LEVEL_PRESSURE = 101_325;
export const SEA_LEVEL_TEMPERATURE = 288.15;
const GAS_CONSTANT = 287.052_87;
const HEAT_CAPACITY_RATIO = 1.4;
const GRAVITY = 9.806_65;
const TROPOSPHERE_LAPSE = 0.006_5;
const TROPOPAUSE_ALTITUDE = 11_000;
const STRATOSPHERE_TEMPERATURE = 216.65;
const UPPER_STRATOSPHERE_ALTITUDE = 20_000;
const UPPER_STRATOSPHERE_LAPSE = -0.001;
/** Highest altitude the table describes; above it the air holds this state. */
const TOP_OF_TABLE = 32_000;
const BOTTOM_OF_TABLE = -500;

/** g / (R * L): the pressure exponent of a layer with lapse L. */
const TROPOSPHERE_EXPONENT = GRAVITY / (GAS_CONSTANT * TROPOSPHERE_LAPSE);
const UPPER_STRATOSPHERE_EXPONENT = GRAVITY / (GAS_CONSTANT * UPPER_STRATOSPHERE_LAPSE);
/** Scale height of the isothermal layer, RT/g: 6,341.6 m. */
const STRATOSPHERE_SCALE_HEIGHT = (GAS_CONSTANT * STRATOSPHERE_TEMPERATURE) / GRAVITY;

const TROPOPAUSE_DENSITY = SEA_LEVEL_DENSITY
  * (STRATOSPHERE_TEMPERATURE / SEA_LEVEL_TEMPERATURE) ** (TROPOSPHERE_EXPONENT - 1);
const UPPER_STRATOSPHERE_DENSITY = TROPOPAUSE_DENSITY
  * Math.exp(-(UPPER_STRATOSPHERE_ALTITUDE - TROPOPAUSE_ALTITUDE) / STRATOSPHERE_SCALE_HEIGHT);

/** ISA air density in kg/m^3 at a geopotential altitude in metres. */
export function standardAirDensity(altitudeMetres: number): number {
  const altitude = clamp(altitudeMetres, BOTTOM_OF_TABLE, TOP_OF_TABLE);
  if (altitude <= TROPOPAUSE_ALTITUDE) {
    const temperature = SEA_LEVEL_TEMPERATURE - TROPOSPHERE_LAPSE * altitude;
    return SEA_LEVEL_DENSITY
      * (temperature / SEA_LEVEL_TEMPERATURE) ** (TROPOSPHERE_EXPONENT - 1);
  }
  if (altitude <= UPPER_STRATOSPHERE_ALTITUDE) {
    return TROPOPAUSE_DENSITY
      * Math.exp(-(altitude - TROPOPAUSE_ALTITUDE) / STRATOSPHERE_SCALE_HEIGHT);
  }
  const temperature = STRATOSPHERE_TEMPERATURE
    - UPPER_STRATOSPHERE_LAPSE * (altitude - UPPER_STRATOSPHERE_ALTITUDE);
  return UPPER_STRATOSPHERE_DENSITY
    * (temperature / STRATOSPHERE_TEMPERATURE) ** (UPPER_STRATOSPHERE_EXPONENT - 1);
}

/**
 * The standard atmosphere's temperature for a given DENSITY, in kelvin.
 *
 * Density, not altitude, because density is what the simulator carries: an
 * `EnvironmentInput.airDensity` override has no altitude, and the engines and
 * the wave drag must read the same air the wing does. ISA density falls
 * monotonically, so each density names exactly one layer and one temperature.
 */
export function standardTemperatureForDensity(airDensity: number): number {
  const density = Math.max(1e-6, airDensity);
  if (density >= TROPOPAUSE_DENSITY) {
    return SEA_LEVEL_TEMPERATURE
      * (density / SEA_LEVEL_DENSITY) ** (1 / (TROPOSPHERE_EXPONENT - 1));
  }
  if (density >= UPPER_STRATOSPHERE_DENSITY) return STRATOSPHERE_TEMPERATURE;
  return STRATOSPHERE_TEMPERATURE
    * (density / UPPER_STRATOSPHERE_DENSITY) ** (1 / (UPPER_STRATOSPHERE_EXPONENT - 1));
}

/** Speed of sound in m/s in air of the given density, on the standard day. */
export function speedOfSoundForDensity(airDensity: number): number {
  return Math.sqrt(HEAT_CAPACITY_RATIO * GAS_CONSTANT * standardTemperatureForDensity(airDensity));
}

/** Static pressure in pascals in air of the given density, on the standard day. */
export function pressureForDensity(airDensity: number): number {
  return Math.max(0, airDensity) * GAS_CONSTANT * standardTemperatureForDensity(airDensity);
}
