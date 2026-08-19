import { describe, expect, it } from "vitest";
import { createWorld } from "../src/world/world";
import {
  TERRAIN_REFERENCE_DAY_OF_YEAR,
  sampleTerrain,
  sampleTerrainHeight,
  seasonalHumidityMultiplier,
  seasonalSnowlineDescentMeters,
  seasonalTemperatureOffsetK,
  seasonalTemperatureShift,
  seasonalWinterFraction,
} from "../src/world/terrain";
import { resolveEnvironmentState } from "../src/render/webgpu/nature/EnvironmentDirector";

/**
 * R-13 — the seasonal kernel term (PRE_PHASE_4_REALIGNMENT.md §4).
 *
 * The contract has three parts. (1) ANCHORING: every seasonal function is an
 * exact no-op at the reference midsummer day the world was tuned at, so the
 * shipped look is bit-identical at the default clock. (2) APPEARANCE, NOT
 * ECOLOGY: the snow blanket migrates with the calendar in the baked colours,
 * while biome/moisture/temperature — the fields species selection and
 * wildlife gates read — stay climatic (PHASE_2_EXECUTION_PLAN.md 2-18:
 * "species mix stays climatic"). (3) The same kernel feeds the environment
 * scalars (humidity → D-5 turbidity, snowCoverage) so 2-13a and 4-6 reuse
 * one winter instead of inventing three.
 */

const WINTER_DAY = 19; // coldest day: solstice + ~1 month thermal lag
const LATITUDE = 45;

describe("seasonal kernel (R-13)", () => {
  it("is an exact no-op at the reference day", () => {
    expect(seasonalTemperatureShift(TERRAIN_REFERENCE_DAY_OF_YEAR, LATITUDE)).toBe(0);
    expect(seasonalSnowlineDescentMeters(TERRAIN_REFERENCE_DAY_OF_YEAR, LATITUDE)).toBe(0);
    expect(seasonalWinterFraction(TERRAIN_REFERENCE_DAY_OF_YEAR, LATITUDE)).toBe(0);
    expect(seasonalHumidityMultiplier(TERRAIN_REFERENCE_DAY_OF_YEAR, LATITUDE)).toBe(1);
  });

  it("cools toward midwinter and lowers the snowline", () => {
    const summer = seasonalTemperatureOffsetK(TERRAIN_REFERENCE_DAY_OF_YEAR, LATITUDE);
    const winter = seasonalTemperatureOffsetK(WINTER_DAY, LATITUDE);
    expect(winter).toBeLessThan(summer);
    expect(seasonalTemperatureShift(WINTER_DAY, LATITUDE)).toBeLessThan(-0.3);
    const descent = seasonalSnowlineDescentMeters(WINTER_DAY, LATITUDE);
    expect(descent).toBeGreaterThan(800);
    expect(descent).toBeLessThan(2_450);
    expect(seasonalWinterFraction(WINTER_DAY, LATITUDE)).toBeGreaterThan(0.85);
    expect(seasonalHumidityMultiplier(WINTER_DAY, LATITUDE)).toBeLessThan(0.7);
  });

  it("flips phase in the southern hemisphere and vanishes at the equator", () => {
    // Day 19 is the depth of northern winter but high southern summer.
    expect(seasonalTemperatureOffsetK(WINTER_DAY, -LATITUDE)).toBeGreaterThan(0);
    expect(seasonalTemperatureOffsetK(WINTER_DAY, 0) + 0).toBe(0);
    expect(seasonalWinterFraction(WINTER_DAY, 0)).toBe(0);
  });

  it("keeps the default-clock terrain sample bit-identical (anchoring)", () => {
    const world = createWorld("r13-anchor");
    for (const [x, z] of [[120, -340], [5_000, 2_000], [-9_000, 7_500], [800, 800]] as const) {
      const implicitDefault = sampleTerrain(world, x, z);
      const explicitReference = sampleTerrain(
        world, x, z, undefined, TERRAIN_REFERENCE_DAY_OF_YEAR,
      );
      expect(implicitDefault.color).toEqual(explicitReference.color);
      expect(implicitDefault.biome).toBe(explicitReference.biome);
      expect(implicitDefault.temperature).toBe(explicitReference.temperature);
    }
  });

  it("whitens winter ground without touching the ecological fields", () => {
    const world = createWorld("r13-winter");
    // Find land comfortably above the descended winter snowline but below
    // the climatic 1,520 m line, so summer shows ground and winter shows snow.
    const descent = seasonalSnowlineDescentMeters(WINTER_DAY, world.latitudeDegrees);
    let found: { x: number; z: number } | null = null;
    for (let radius = 500; radius <= 20_000 && !found; radius += 500) {
      for (let step = 0; step < 16 && !found; step += 1) {
        const angle = (step / 16) * Math.PI * 2;
        const x = Math.cos(angle) * radius;
        const z = Math.sin(angle) * radius;
        const height = sampleTerrainHeight(world, x, z);
        const above = height - world.seaLevel;
        if (above > 1_520 - descent + 150 && above < 1_470) found = { x, z };
      }
    }
    expect(found, "the test world should have mid-altitude terrain").not.toBeNull();
    const summer = sampleTerrain(world, found!.x, found!.z);
    const winter = sampleTerrain(world, found!.x, found!.z, undefined, WINTER_DAY);
    // Ecology identical — species selection must not move with the calendar.
    expect(winter.biome).toBe(summer.biome);
    expect(winter.temperature).toBe(summer.temperature);
    expect(winter.moisture).toBe(summer.moisture);
    // Appearance whitened: winter colour is brighter and less saturated.
    const summerLuma = summer.color.r + summer.color.g + summer.color.b;
    const winterLuma = winter.color.r + winter.color.g + winter.color.b;
    expect(winterLuma).toBeGreaterThan(summerLuma + 0.5);
  });

  it("drives the environment scalars from the same kernel", () => {
    const clockSummer = { dayOfYear: TERRAIN_REFERENCE_DAY_OF_YEAR, solarTimeHours: 12.5 };
    const clockWinter = { dayOfYear: WINTER_DAY, solarTimeHours: 12.5 };
    const summer = resolveEnvironmentState({
      clock: clockSummer, latitudeDegrees: LATITUDE, weather: "clear",
    });
    const winter = resolveEnvironmentState({
      clock: clockWinter, latitudeDegrees: LATITUDE, weather: "clear",
    });
    // Winter air is clearer (D-5's turbidity multiplier consumes humidity).
    expect(winter.weather.relativeHumidity).toBeLessThan(summer.weather.relativeHumidity);
    expect(summer.weather.snowCoverage).toBe(0);
    expect(winter.weather.snowCoverage).toBeGreaterThan(0.5);
    // Wetness stays unowned until a precipitation model exists (recorded).
    expect(winter.weather.surfaceWetness).toBe(0);
  });
});
