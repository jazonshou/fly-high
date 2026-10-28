import { describe, expect, it } from "vitest";
import {
  PERF_CAPTURE_SEED,
  PERF_CAPTURE_SHOTS,
  WALK_SHOT_ROAD_HEAD_OFFSET,
  type PerfCaptureShotDefinition,
  yawForSunBearing,
  PERF_CAPTURE_DEFAULT_CLOCK,
} from "../scripts/perf-capture.mts";
import { PERSON_SURFACE_WATER, type FlightVisualState, type PersonVisualState } from "../src/game/types";
import { createSurfaceSpawn } from "../src/game/surfaceSpawn";
import { sunDirectionForClock } from "../src/render/webgpu/nature/EnvironmentDirector";
import { CAR_SEATING, PERSON } from "../src/vehicles/person";
import { createWorld, sampleTerrainHeight } from "../src/world";
import { homeMarina, marinaStartPose } from "../src/world/marina";
import { worldToMarina } from "../src/world/marinaLayout";
import type { WorldDefinition } from "../src/world/types";
import { resolveShotPlacement, walkShotState } from "./perf/shotPlacement";
import {
  WALK_SHOT_CAR_CG_ABOVE_GROUND,
  WALK_SHOT_DOOR_STAND,
  WALK_SHOT_EYE_HEIGHT,
  WALK_SHOT_STATURE,
  WALK_SHOT_SURFACE_WATER,
  walkShotLookPitchRadians,
} from "./perf/walkShotState";

/**
 * The walker shots (`PerfCaptureShotDefinition.walk`): the person posed on
 * foot or in the water in a car session, the car parked, as both harnesses
 * build them.
 */

const walkShots = PERF_CAPTURE_SHOTS.filter((shot) => shot.walk !== undefined);
const world = createWorld(PERF_CAPTURE_SEED);

function shotState(name: string): { shot: PerfCaptureShotDefinition; state: FlightVisualState; person: PersonVisualState } {
  const shot = walkShots.find((candidate) => candidate.name === name)!;
  const placement = resolveShotPlacement(world, shot);
  const x = (world.airport?.centerX ?? 0) + placement.offsetXMeters;
  const z = (world.airport?.centerZ ?? 0) + placement.offsetZMeters;
  const clock = shot.clock ?? PERF_CAPTURE_DEFAULT_CLOCK;
  const yawDegrees = shot.relativeSunBearingDegrees !== undefined
    ? yawForSunBearing(sunDirectionForClock(clock, world.latitudeDegrees), shot.relativeSunBearingDegrees)
    : 0;
  const state = walkShotState(world, shot.walk!, { x, z, yawDegrees }, 500);
  if (state.vehicle?.kind !== "person") throw new Error(`${name}: not a person payload`);
  return { shot, state, person: state.vehicle };
}

/** The parked car's heading and the walker's offset from it along and across it. */
function fromCar(state: FlightVisualState): { carHeading: number; along: number; across: number } {
  const car = state.walking!.car!;
  const carHeading = (car.heading * Math.PI) / 180;
  const dx = state.position.x - car.position.x;
  const dz = state.position.z - car.position.z;
  return {
    carHeading,
    along: dx * Math.sin(carHeading) + dz * Math.cos(carHeading),
    across: -dx * Math.cos(carHeading) + dz * Math.sin(carHeading),
  };
}

function expectParked(state: FlightVisualState, groundWorld: WorldDefinition): void {
  expect(state.walking?.driven).toBe("person");
  expect(state.walking?.doors).toEqual([0, 0]);
  const car = state.walking!.car!;
  expect(car.vehicle?.kind).toBe("car");
  if (car.vehicle?.kind !== "car") return;
  expect(car.vehicle.selector).toBe("P");
  expect(car.vehicle.speed).toBe(0);
  // On dry ground, its CG over it as a car stands.
  const ground = sampleTerrainHeight(groundWorld, car.position.x, car.position.z);
  expect(ground).toBeGreaterThan(groundWorld.seaLevel);
  expect(car.position.y - ground).toBeGreaterThan(WALK_SHOT_CAR_CG_ABOVE_GROUND - 0.3);
  expect(car.position.y - ground).toBeLessThan(WALK_SHOT_CAR_CG_ABOVE_GROUND + 0.3);
}

describe("walker shots", () => {
  it("are six walker views, the last shots of all, with no car or boat run of their own", () => {
    expect(walkShots.map((shot) => shot.name)).toEqual([
      "walk-door-chase",
      "walk-clearing-chase",
      "swim-sea-chase",
      "dive-sea-up",
      "dive-marina-basin",
      "walk-marina-dusk",
    ]);
    expect(PERF_CAPTURE_SHOTS.slice(-walkShots.length).every((shot) => shot.walk !== undefined)).toBe(true);
    for (const shot of walkShots) {
      expect(shot.car).toBeUndefined();
      expect(shot.boat).toBeUndefined();
      expect(shot.cameraMode).toBe("chase");
      expect(shot.comparesToBaseline).toBe(false);
    }
  });

  it("type the walker's and the car's numbers as PERSON and CAR_SEATING have them", () => {
    expect(WALK_SHOT_STATURE).toBe(PERSON.stature);
    expect(WALK_SHOT_EYE_HEIGHT).toBeCloseTo(PERSON.eyeHeight, 12);
    expect(WALK_SHOT_DOOR_STAND.forward).toBe(CAR_SEATING.doorStand.forward);
    expect(WALK_SHOT_DOOR_STAND.right).toBe(CAR_SEATING.doorStand.right);
    expect(WALK_SHOT_CAR_CG_ABOVE_GROUND).toBe(CAR_SEATING.cgAboveGround);
    expect(WALK_SHOT_SURFACE_WATER).toBe(PERSON_SURFACE_WATER);
  });

  it("stand the foot start's car where a car session's car starts", () => {
    const spawn = createSurfaceSpawn(world, "landcruiser");
    expect(spawn.position.x - world.airport!.centerX).toBeCloseTo(WALK_SHOT_ROAD_HEAD_OFFSET.x, 1);
    expect(spawn.position.z - world.airport!.centerZ).toBeCloseTo(WALK_SHOT_ROAD_HEAD_OFFSET.z, 1);
    expect((spawn.heading * 180) / Math.PI).toBeCloseTo(WALK_SHOT_ROAD_HEAD_OFFSET.headingDegrees, 1);
    const { state } = shotState("walk-door-chase");
    // The pose's body origin sits between the axles rather than on the search point.
    const car = state.walking!.car!;
    expect(Math.hypot(car.position.x - spawn.position.x, car.position.z - spawn.position.z)).toBeLessThan(0.3);
    expect(Math.cos((car.heading * Math.PI) / 180 - spawn.heading)).toBeGreaterThan(0.9999);
  });

  it("walk on from the driver's door along the car, feet on the ground", () => {
    for (const name of ["walk-door-chase", "walk-clearing-chase"]) {
      const { shot, state, person } = shotState(name);
      expectParked(state, world);
      const { carHeading, along, across } = fromCar(state);
      expect(across).toBeCloseTo(WALK_SHOT_DOOR_STAND.right, 1);
      expect(along).toBeCloseTo(WALK_SHOT_DOOR_STAND.forward + shot.walk!.aheadMeters!, 1);
      expect(Math.cos((state.heading * Math.PI) / 180 - carHeading)).toBeGreaterThan(0.9999);
      expect(state.position.y).toBeCloseTo(sampleTerrainHeight(world, state.position.x, state.position.z), 6);
      expect(person.mode).toBe("walk");
      expect(person.grounded).toBe(true);
      expect(person.waterDepth).toBe(0);
      expect(Math.hypot(state.velocity.x, state.velocity.z)).toBeCloseTo(PERSON.walkSpeed, 6);
    }
  });

  it("swim and dive over the bed asked for, the shore ahead and the car parked up it", () => {
    for (const name of ["swim-sea-chase", "dive-sea-up"]) {
      const { shot, state, person } = shotState(name);
      const run = shot.walk!;
      expectParked(state, world);
      const bed = sampleTerrainHeight(world, state.position.x, state.position.z);
      expect(world.seaLevel - bed).toBeCloseTo(run.bedDepthMeters!, 0);
      expect(person.headDepth).toBeCloseTo(run.headDepthMeters!, 9);
      expect(state.position.y + WALK_SHOT_EYE_HEIGHT).toBeCloseTo(world.seaLevel - run.headDepthMeters!, 9);
      expect(person.mode).toBe(run.mode);
      expect(person.grounded).toBe(false);
      expect(person.surface).toBe(PERSON_SURFACE_WATER);
      // Facing the shore: dry land within 400 m straight ahead.
      const heading = (state.heading * Math.PI) / 180;
      const ahead = sampleTerrainHeight(world, state.position.x + Math.sin(heading) * 400, state.position.z + Math.cos(heading) * 400);
      expect(ahead).toBeGreaterThan(world.seaLevel);
    }
    expect(shotState("swim-sea-chase").person.submersion).toBeLessThan(1);
    expect(shotState("dive-sea-up").person.submersion).toBe(1);
    expect(walkShotLookPitchRadians(shotState("dive-sea-up").shot.walk)).toBeCloseTo((35 * Math.PI) / 180, 12);
    expect(walkShotLookPitchRadians(shotState("swim-sea-chase").shot.walk)).toBe(0);
  });

  it("dive in the marina's basin off the start berth, and walk out along its pier at dusk", () => {
    const layout = homeMarina(world);
    const berth = marinaStartPose(world);
    const basin = shotState("dive-marina-basin");
    expectParked(basin.state, world);
    expect(Math.hypot(basin.state.position.x - berth.x, basin.state.position.z - berth.z)).toBeLessThan(0.01);
    expect(basin.person.headDepth).toBeCloseTo(1.5, 9);
    expect(berth.stillWaterY - sampleTerrainHeight(world, berth.x, berth.z)).toBeGreaterThan(2);

    const pier = shotState("walk-marina-dusk");
    expectParked(pier.state, world);
    const deck = layout.boxes.find((box) => box.kind === "pierDeck")!;
    const local = worldToMarina(layout.frame, pier.state.position.x, pier.state.position.z);
    const dr = local.right - deck.right;
    const dout = local.out - deck.out;
    // Inside the deck in plan, standing on its top.
    expect(Math.abs(dr * Math.cos(deck.yaw) - dout * Math.sin(deck.yaw))).toBeLessThan(deck.halfRight);
    expect(Math.abs(dr * Math.sin(deck.yaw) + dout * Math.cos(deck.yaw))).toBeLessThan(deck.halfOut);
    expect(pier.state.position.y).toBeCloseTo(deck.y + deck.halfHeight, 9);
    expect(pier.person.mode).toBe("walk");
    // The car in the car park.
    const car = pier.state.walking!.car!;
    expect(Math.hypot(car.position.x - layout.carParkAnchor.x, car.position.z - layout.carParkAnchor.z)).toBeLessThan(0.3);
  });

  it("build the same state every time", () => {
    for (const shot of walkShots) {
      expect(shotState(shot.name).state).toEqual(shotState(shot.name).state);
    }
  });
});
