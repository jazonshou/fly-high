import { STRUCTURE_LAMP_NEVER, STRUCTURE_LAMP_STEPS } from "./structureNightLighting";

/**
 * What a structure vertex's surface attribute carries: its surface id, and
 * its building's lamp threshold (`structureLampThreshold`) and weather
 * (`structureWeatherCode`: wear step x 4 + climate), packed as one integer
 * in a float32, so the buildings' night lights and weathering add no vertex
 * attribute and no varying:
 *
 *   code = id + STRIDE x (lampSteps + LAMP_SPAN x weather)
 *
 * with id < STRIDE, lampSteps = threshold x STRUCTURE_LAMP_STEPS in
 * [0, LAMP_SPAN) and weather in [0, WEATHER_CODES). The largest code,
 * 31 + 32 x (4,096 + 4,097 x 63), is 8,390,655: inside a float32's exact
 * integers (2^24), so the vertex stage decodes it exactly.
 *
 * The vertex stage passes the fragment stage a smaller one, for the lit flag
 * it decided: id + STRIDE x lit + 2 STRIDE x weather (below 4,096).
 */
export const STRUCTURE_CODE_STRIDE = 32;
export const STRUCTURE_CODE_LAMP_SPAN = STRUCTURE_LAMP_STEPS * STRUCTURE_LAMP_NEVER + 1;
export const STRUCTURE_WEATHER_CODES = 64;

export function structureSurfaceCode(surfaceId: number, lampThreshold: number, weather: number): number {
  const steps = Math.round(lampThreshold * STRUCTURE_LAMP_STEPS);
  if (!(surfaceId >= 0 && surfaceId < STRUCTURE_CODE_STRIDE) || !(steps >= 0 && steps < STRUCTURE_CODE_LAMP_SPAN)
    || !(weather >= 0 && weather < STRUCTURE_WEATHER_CODES)) {
    throw new RangeError(`structure surface code out of range: id ${surfaceId}, lamp ${lampThreshold}, weather ${weather}`);
  }
  return surfaceId + STRUCTURE_CODE_STRIDE * (steps + STRUCTURE_CODE_LAMP_SPAN * weather);
}

/** The offset a building adds to its vertices' surface ids. */
export function structureBuildingCodeOffset(lampThreshold: number, weather: number): number {
  return structureSurfaceCode(0, lampThreshold, weather);
}

/** The vertex stage's decode, in the same float32 arithmetic (for tests). */
export function decodeStructureSurfaceCode(code: number): { id: number; lampThreshold: number; weather: number } {
  const c = Math.fround(code);
  const total = Math.floor((c + 0.5) / STRUCTURE_CODE_STRIDE);
  const weather = Math.floor((total + 0.5) / STRUCTURE_CODE_LAMP_SPAN);
  const steps = total - STRUCTURE_CODE_LAMP_SPAN * weather;
  return { id: c - STRUCTURE_CODE_STRIDE * total, lampThreshold: steps / STRUCTURE_LAMP_STEPS, weather };
}
