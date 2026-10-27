import { describe, expect, it } from "vitest";
import { benchPathDistance, createBenchPath, createBenchVisualState, writeFlightState } from "../src/bench/path";
import { BENCH_SEED, benchTimings } from "../src/bench/plan";
import { runwayStartAlong } from "../src/game/spawn";
import { aircraftDefinition } from "../src/sim";
import { createWorld, sampleTerrainHeight, worldToRunway } from "../src/world";

/**
 * The bench flies one fixed seed, so the seed has to give the route
 * something to render: a home runway to roll down, then land with some
 * relief under the cruise rather than open sea. If this fails after a world
 * change, move the route (or the seed), bump `BENCH_PATH_ID`, and pin the
 * new fingerprints in src/bench/plan.ts.
 */
describe("the bench seed's route", () => {
  const world = createWorld(BENCH_SEED);
  const timings = benchTimings(false);
  const path = createBenchPath(world, timings);

  it("has a home airport and rolls down its runway without leaving it", () => {
    const airport = world.airport;
    expect(airport).not.toBeNull();
    if (!airport) return;
    const start = runwayStartAlong(airport, aircraftDefinition("trainer"));
    const state = createBenchVisualState();
    for (let t = 0; t <= timings.rollEndS; t += 0.5) {
      writeFlightState(path, t, state);
      const local = worldToRunway(airport, state.position.x, state.position.z);
      expect(local.along).toBeCloseTo(start + benchPathDistance(path, t), 6);
      expect(Math.abs(local.across)).toBeLessThan(1e-6);
      expect(local.along).toBeLessThan(airport.runwayLength / 2);
    }
    // Off the ground before the far threshold.
    writeFlightState(path, timings.rollEndS + 2, state);
    expect(worldToRunway(airport, state.position.x, state.position.z).along).toBeLessThan(airport.runwayLength / 2);
    expect(state.onGround).toBe(false);
  });

  it("crosses mostly land with at least 80 m of relief over its 7.2 km", () => {
    const state = createBenchVisualState();
    let land = 0;
    let samples = 0;
    let lowest = Number.POSITIVE_INFINITY;
    let highest = Number.NEGATIVE_INFINITY;
    for (let t = 0; t <= timings.flightS; t += 0.25) {
      writeFlightState(path, t, state);
      const terrain = sampleTerrainHeight(world, state.position.x, state.position.z);
      samples += 1;
      if (terrain > world.seaLevel) land += 1;
      lowest = Math.min(lowest, terrain);
      highest = Math.max(highest, terrain);
    }
    expect(benchPathDistance(path, timings.flightS)).toBeCloseTo(7_200, 6);
    expect(land / samples).toBeGreaterThanOrEqual(0.5);
    expect(highest - lowest).toBeGreaterThanOrEqual(80);
  });
});
