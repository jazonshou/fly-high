import { describe, expect, it } from "vitest";
import {
  createSurfaceRecoverySpawn,
  createSurfaceSpawn,
  findOpenWater,
  OPEN_WATER_DEPTH,
} from "../src/game/surfaceSpawn";
import { interpolateFlightState } from "../src/game/SimulationClient";
import { INITIAL_VISUAL_STATE, type BoatControlState, type FlightVisualState } from "../src/game/types";
import { inputProfileForSpawn, stepBoatLever } from "../src/input";
import { chaseCameraProfile } from "../src/render/FlightRenderer";
import { validateSettings } from "../src/settings";
import {
  NEUTRAL_BOAT_CONTROLS,
  StandInBoatSimulator,
  surfaceVisualState,
  type SurfaceVehicleEnvironment,
} from "../src/sim/surface";
import { CalmWaterSurface } from "../src/sim/water";
import { surfaceVehicleSpec } from "../src/vehicles/catalogue";
import { createWorld, sampleTerrainHeight } from "../src/world";
import { marinaStartPose } from "../src/world/marina";

/**
 * The shared vehicle base, before any boat physics exists: the stand-in
 * simulator drives the whole seam (worker, input, HUD, renderer), so the
 * contract it keeps is the one the real `BoatSimulator` inherits.
 */

const STEP = 1 / 120;

function environment(bedHeight: (x: number, z: number) => number): SurfaceVehicleEnvironment {
  return {
    water: new CalmWaterSurface(0, bedHeight),
    wind: { x: 0, y: 0, z: 0 },
    bedHeight,
    gravity: 9.80665,
  };
}

function controls(boat: Partial<BoatControlState> = {}) {
  return { assist: "pilot" as const, boat: { ...NEUTRAL_BOAT_CONTROLS, ...boat } };
}

function run(boat: StandInBoatSimulator, seconds: number): void {
  for (let t = 0; t < seconds; t += STEP) boat.step(STEP);
}

describe("stand-in boat", () => {
  const deep = environment(() => -30);

  it("stays fast at the berth until the lever moves, then gets under way", () => {
    const boat = new StandInBoatSimulator({ position: { x: 0, y: 0, z: 0 }, heading: Math.PI / 2, moored: true });
    boat.setEnvironment(deep);
    boat.setControls(controls());
    run(boat, 3);
    let snapshot = boat.snapshot();
    expect(snapshot.payload.moored).toBe(true);
    expect(snapshot.payload.speedThroughWater).toBeCloseTo(0, 6);
    expect(Math.hypot(snapshot.position.x, snapshot.position.z)).toBeLessThan(0.01);

    boat.setControls(controls({ lever: 1 }));
    run(boat, 12);
    snapshot = boat.snapshot();
    expect(snapshot.payload.moored).toBe(false);
    expect(snapshot.payload.gear).toBe("forward");
    expect(snapshot.payload.speedThroughWater).toBeGreaterThan(15);
    // Heading pi/2 is east, +X, as `FlightTelemetry.heading` has it.
    expect(snapshot.position.x).toBeGreaterThan(50);
    expect(Math.abs(snapshot.position.z)).toBeLessThan(1);
  });

  it("takes the first mooring count it sees as a baseline, and only a change as a press", () => {
    const boat = new StandInBoatSimulator({ position: { x: 0, y: 0, z: 0 }, heading: 0, moored: true });
    boat.setEnvironment(deep);
    boat.setControls(controls({ moorPresses: 7 }));
    run(boat, 1);
    expect(boat.snapshot().payload.moored).toBe(true);
    boat.setControls(controls({ moorPresses: 8 }));
    run(boat, 1);
    expect(boat.snapshot().payload.moored).toBe(false);
    boat.setControls(controls({ moorPresses: 9 }));
    run(boat, 1);
    expect(boat.snapshot().payload.moored).toBe(true);
  });

  it("wrecks on a fast grounding", () => {
    // Deep water for 150 m east, then a shelf 0.2 m under the surface.
    const shelf = environment((x) => (x < 150 ? -30 : -0.2));
    const boat = new StandInBoatSimulator({ position: { x: 0, y: 0, z: 0 }, heading: Math.PI / 2, moored: false });
    boat.setEnvironment(shelf);
    boat.setControls(controls({ lever: 1 }));
    run(boat, 30);
    expect(boat.snapshot().crashed).toBe(true);
  });
});

describe("boat lever", () => {
  it("stops at neutral when it crosses it and holds there until released", () => {
    let lever = stepBoatLever(0.1, -1, false, 0.5);
    expect(lever).toEqual({ lever: 0, detentHeld: true });
    lever = stepBoatLever(lever.lever, -1, lever.detentHeld, 0.5);
    expect(lever).toEqual({ lever: 0, detentHeld: true });
    lever = stepBoatLever(lever.lever, 0, lever.detentHeld, 0.5);
    expect(lever.detentHeld).toBe(false);
    lever = stepBoatLever(lever.lever, -1, lever.detentHeld, 0.5);
    expect(lever.lever).toBeLessThan(0);
  });

  it("follows the spawn: a dock start drives a boat", () => {
    expect(inputProfileForSpawn("dock")).toBe("boat");
    expect(inputProfileForSpawn("runway")).toBe("aircraft");
    expect(inputProfileForSpawn("airborne")).toBe("aircraft");
  });
});

describe("vehicle setting", () => {
  it("defaults to the saved aircraft, keeps a boat, and refuses an unknown kind", () => {
    expect(validateSettings({ aircraft: "jet" }).vehicle).toBe("jet");
    expect(validateSettings({}).vehicle).toBe("trainer");
    const boat = validateSettings({ aircraft: "bizjet", vehicle: "speedboat" });
    expect(boat.vehicle).toBe("speedboat");
    expect(boat.aircraft).toBe("bizjet");
    expect(validateSettings({ aircraft: "airliner", vehicle: "submarine" }).vehicle).toBe("airliner");
  });
});

describe("surface visual state", () => {
  it("carries the pose, the speed through the water and the payload", () => {
    const boat = new StandInBoatSimulator({ position: { x: 0, y: 0, z: 0 }, heading: Math.PI / 2, moored: false });
    boat.setEnvironment(environment(() => -30));
    boat.setControls(controls({ lever: 1 }));
    run(boat, 6);
    const snapshot = boat.snapshot();
    const state = surfaceVisualState(snapshot, undefined);
    expect(state.heading).toBeCloseTo(90, 3);
    expect(state.airspeed).toBe(snapshot.payload.speedThroughWater);
    expect(state.vehicle).toBe(snapshot.payload);
    expect(state.autoland).toBeNull();
    expect(state.crashed).toBe(false);
  });

  it("switches the payload with the snapshot flags rather than blending it", () => {
    const boat = new StandInBoatSimulator({ position: { x: 0, y: 0, z: 0 }, heading: 0, moored: true });
    boat.setEnvironment(environment(() => -30));
    boat.setControls(controls());
    boat.step(STEP);
    const afloat = surfaceVisualState(boat.snapshot(), undefined);
    const aircraft: FlightVisualState = { ...INITIAL_VISUAL_STATE };
    expect(interpolateFlightState(afloat, afloat, 0.5).vehicle?.kind).toBe("boat");
    expect(interpolateFlightState(aircraft, aircraft, 0.5).vehicle).toBeUndefined();
  });
});

describe("boat spawn", () => {
  it("starts moored in the home marina's start berth, bow out", () => {
    const world = createWorld(0x51a7e);
    const spawn = createSurfaceSpawn(world, "speedboat");
    const pose = marinaStartPose(world);
    expect(spawn.moored).toBe(true);
    expect(spawn.position).toEqual({ x: pose.x, y: pose.stillWaterY, z: pose.z });
    expect(spawn.heading).toBe(pose.headingRadians);
    const depth = world.seaLevel - sampleTerrainHeight(world, spawn.position.x, spawn.position.z);
    expect(depth).toBeGreaterThan(0.45);
  });

  it("recovers a wreck onto open water near it", () => {
    const world = createWorld(0x51a7e);
    const x = world.airport?.centerX ?? 0;
    const z = world.airport?.centerZ ?? 0;
    const spawn = createSurfaceRecoverySpawn(world, "speedboat", x, z);
    const depth = world.seaLevel - sampleTerrainHeight(world, spawn.position.x, spawn.position.z);
    expect(spawn.moored).toBe(false);
    expect(depth).toBeGreaterThanOrEqual(OPEN_WATER_DEPTH);
    expect(findOpenWater(world, x, z)).toMatchObject({ x: spawn.position.x, z: spawn.position.z });
    expect(Math.hypot(spawn.position.x - x, spawn.position.z - z)).toBeLessThan(10_000);
  });
});

describe("boat camera", () => {
  it("frames the boat from its own catalogue entry", () => {
    const spec = surfaceVehicleSpec("speedboat");
    const still = chaseCameraProfile("speedboat", 0);
    expect(still.height).toBe(spec.chase.height);
    expect(still.distance).toBeCloseTo(spec.chase.distance.base, 6);
  });
});
