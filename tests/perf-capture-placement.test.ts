import { describe, expect, it } from "vitest";
import {
  cockpitTerrainCoverage,
  PERF_CAPTURE_DEFAULT_CLOCK,
  PERF_CAPTURE_HEIGHT,
  PERF_CAPTURE_SEED,
  PERF_CAPTURE_SHOTS,
  PERF_CAPTURE_WIDTH,
  yawForSunBearing,
} from "../scripts/perf-capture.mts";
import { sunDirectionForClock } from "../src/render/webgpu/nature/EnvironmentDirector";
import { createWorld, sampleTerrainHeight } from "../src/world";

const highDownShot = PERF_CAPTURE_SHOTS.find(
  (shot) => shot.name === "high-10000ft-down",
);
if (!highDownShot) {
  throw new Error("The high-10000ft-down capture shot is missing");
}
const HIGH_DOWN_SHOT = highDownShot;
const highDownAltitudeMslMeters = HIGH_DOWN_SHOT.altitudeMslMeters;
if (highDownAltitudeMslMeters === null) {
  throw new Error("high-10000ft-down must remain an MSL-anchored capture shot");
}
const HIGH_DOWN_ALTITUDE_MSL_METERS = highDownAltitudeMslMeters;

function highDownCoverage(offsetZMeters: number) {
  const world = createWorld(PERF_CAPTURE_SEED);
  const airportX = world.airport?.centerX ?? 0;
  const airportZ = world.airport?.centerZ ?? 0;
  const clock = HIGH_DOWN_SHOT.clock ?? PERF_CAPTURE_DEFAULT_CLOCK;
  const yawDegrees = HIGH_DOWN_SHOT.relativeSunBearingDegrees === undefined
    ? 0
    : yawForSunBearing(
        sunDirectionForClock(clock, world.latitudeDegrees),
        HIGH_DOWN_SHOT.relativeSunBearingDegrees,
      );
  return cockpitTerrainCoverage({
    aircraftPosition: [
      airportX + HIGH_DOWN_SHOT.offsetXMeters,
      HIGH_DOWN_ALTITUDE_MSL_METERS,
      airportZ + offsetZMeters,
    ],
    yawDegrees,
    pitchDownDegrees: HIGH_DOWN_SHOT.pitchDownDegrees,
    seaLevelMeters: world.seaLevel,
    terrainHeightAt: (x, z) => sampleTerrainHeight(world, x, z),
    viewportWidth: HIGH_DOWN_SHOT.viewportWidth ?? PERF_CAPTURE_WIDTH,
    viewportHeight: HIGH_DOWN_SHOT.viewportHeight ?? PERF_CAPTURE_HEIGHT,
  });
}

describe("perf-capture semantic placement", () => {
  it("keeps the 10,000 ft downward terrain shot over terrain", () => {
    expect(HIGH_DOWN_SHOT.cameraMode).toBe("cockpit");
    expect(HIGH_DOWN_SHOT.offsetZMeters).toBe(8_000);

    const coverage = highDownCoverage(HIGH_DOWN_SHOT.offsetZMeters);

    expect(coverage.sampledRays).toBe(41 * 23);
    expect(coverage.terrainHitFraction).toBeGreaterThanOrEqual(0.95);
    expect(coverage.terrainHits).toBe(coverage.sampledRays);
    expect(coverage.seaHits).toBe(0);
    expect(coverage.skyRays).toBe(0);
  });

  it("fails the exact legacy open-ocean placement", () => {
    const legacyCoverage = highDownCoverage(-6_000);

    expect(legacyCoverage.terrainHitFraction).toBeLessThan(0.05);
    expect(legacyCoverage.terrainHits).toBe(0);
    expect(legacyCoverage.seaHits).toBe(legacyCoverage.sampledRays);
  });
});
