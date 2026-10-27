import { describe, expect, it } from "vitest";
import {
  PERF_CAPTURE_DEFAULT_CLOCK,
  PERF_CAPTURE_SEED,
  PERF_CAPTURE_SHOTS,
  headingVectorFromYaw,
  yawForSunBearing,
} from "../scripts/perf-capture.mts";
import type { BoatVisualState } from "../src/game/types";
import { sunDirectionForClock } from "../src/render/webgpu/nature/EnvironmentDirector";
import { flightAnglesOf } from "../src/sim/surface";
import { createWorld } from "../src/world";
import { marinaStartPose } from "../src/world/marina";
import { boatShotState } from "./perf/shotPlacement";

/**
 * The boat shots (`PerfCaptureShotDefinition.boat`): the pose the two
 * harnesses photograph is the simulator's, set down where the shot is placed
 * and heading where the shot looks.
 */

const world = createWorld(PERF_CAPTURE_SEED);
const KNOT = 1_852 / 3_600;
const boatShots = PERF_CAPTURE_SHOTS.filter((shot) => shot.boat !== undefined);

describe("boat shots", () => {
  it("are four boat views, appended after every aircraft shot, with only the cars after them", () => {
    expect(boatShots.map((shot) => shot.name)).toEqual([
      "boat-moored-dock",
      "boat-planing-35kn",
      "boat-helm",
      "boat-wake-lowsun",
    ]);
    const firstBoat = PERF_CAPTURE_SHOTS.findIndex((shot) => shot.boat !== undefined);
    expect(PERF_CAPTURE_SHOTS.slice(firstBoat).every((shot) => shot.boat !== undefined || shot.car !== undefined)).toBe(true);
  });

  it("start the dock shot made fast at the marina's start berth, at rest", () => {
    const berth = marinaStartPose(world);
    const state = boatShotState(world, { start: "dock", legs: [] }, { x: 0, z: 0, yawDegrees: 0 }, 500);
    const boat = state.vehicle as BoatVisualState;
    expect(boat.kind).toBe("boat");
    expect(boat.moored).toBe(true);
    expect(state.position.x).toBeCloseTo(berth.x, 6);
    expect(state.position.z).toBeCloseTo(berth.z, 6);
    expect(Math.hypot(state.velocity.x, state.velocity.z)).toBe(0);
    const turn = flightAnglesOf(state.orientation).heading - berth.headingRadians;
    expect(Math.atan2(Math.sin(turn), Math.cos(turn))).toBeCloseTo(0, 6);
    expect(state.simulationTime).toBe(500);
  });

  it("refuse legs on a dock start, which lies moored", () => {
    expect(() => boatShotState(
      world,
      { start: "dock", legs: [{ seconds: 1, lever: 1, steer: 0 }] },
      { x: 0, z: 0, yawDegrees: 0 },
      0,
    )).toThrow(/moored/u);
  });

  it("run the planing shots up to 35 knots on the plane, set down at the placement on the shot's heading", () => {
    const shot = PERF_CAPTURE_SHOTS.find((candidate) => candidate.name === "boat-wake-lowsun")!;
    const clock = shot.clock ?? PERF_CAPTURE_DEFAULT_CLOCK;
    const yawDegrees = yawForSunBearing(
      sunDirectionForClock(clock, world.latitudeDegrees),
      shot.relativeSunBearingDegrees!,
    );
    const state = boatShotState(world, shot.boat!, { x: 1_234, z: -5_678, yawDegrees }, 0);
    const boat = state.vehicle as BoatVisualState;
    expect(boat.speedThroughWater / KNOT).toBeGreaterThan(34);
    expect(boat.speedThroughWater / KNOT).toBeLessThan(36);
    expect(boat.planing).toBeGreaterThan(0.5);
    expect(boat.sprayRootCount).toBeGreaterThan(0);
    expect(state.position.x).toBe(1_234);
    expect(state.position.z).toBe(-5_678);
    // Planing: the CG rides above its rest height, and nowhere near the bottom.
    expect(state.position.y - world.seaLevel).toBeGreaterThan(0.2);
    expect(state.position.y - world.seaLevel).toBeLessThan(0.6);
    // Bow and track both along the shot's yaw.
    const heading = headingVectorFromYaw(yawDegrees);
    const forward = Math.PI / 2 + (yawDegrees * Math.PI) / 180;
    const delta = Math.atan2(
      Math.sin(flightAnglesOf(state.orientation).heading - forward),
      Math.cos(flightAnglesOf(state.orientation).heading - forward),
    );
    expect(Math.abs(delta)).toBeLessThan(1e-9);
    const speed = Math.hypot(state.velocity.x, state.velocity.z);
    expect((state.velocity.x * heading.x + state.velocity.z * heading.z) / speed).toBeGreaterThan(0.99);
  });
});
