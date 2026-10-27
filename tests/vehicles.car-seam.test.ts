import { describe, expect, it } from "vitest";
import { createSurfaceRecoverySpawn, createSurfaceSpawn } from "../src/game/surfaceSpawn";
import type { CarControlState } from "../src/game/types";
import { inputProfileForSpawn } from "../src/input";
import { validateSettings } from "../src/settings";
import { GroundVehicleSimulator } from "../src/sim/ground";
import {
  createSurfaceSimulator,
  NEUTRAL_BOAT_CONTROLS,
  NEUTRAL_CAR_CONTROLS,
  surfaceVisualState,
  type SurfaceVehicleEnvironment,
  type SurfaceVehicleSimulator,
} from "../src/sim/surface";
import { sampleGroundContact, sampleGroundHeight } from "../src/sim/terrainGrid";
import { CalmWaterSurface } from "../src/sim/water";
import { surfaceVehicleSpec } from "../src/vehicles/catalogue";
import { LC76_GEOMETRY } from "../src/vehicles/landcruiser76";
import { vehicleClass } from "../src/vehicles/kinds";
import { createWorld, worldToRunway, type WorldDefinition } from "../src/world";
import { airportRoadFenceOpening, airportRoadHead } from "../src/world/roads/roadNodes";
import { surfaceSpawnKind } from "../src/workers/protocol";

/**
 * The car's side of the shared vehicle seam, driven through the car's
 * simulator: the kind, the road-head start, the controls block and the payload
 * reach every consumer the boat's do.
 */

const STEP = 1 / 120;

function environment(world: WorldDefinition): SurfaceVehicleEnvironment {
  const bed = (x: number, z: number) => sampleGroundHeight(world, x, z);
  return {
    water: new CalmWaterSurface(world.seaLevel, bed),
    wind: { x: 0, y: 0, z: 0 },
    bedHeight: bed,
    groundContact: (x, z, target) => sampleGroundContact(world, x, z, target),
    world,
    colliders: null,
    gravity: 9.80665,
  };
}

function drive(car: SurfaceVehicleSimulator, seconds: number, input: Partial<CarControlState>): void {
  car.setControls({ assist: "pilot", boat: NEUTRAL_BOAT_CONTROLS, car: { ...NEUTRAL_CAR_CONTROLS, ...input } });
  for (let t = 0; t < seconds; t += STEP) car.step(STEP);
}

describe("car seam", () => {
  const world = createWorld(0x51a7e);

  it("is the car class, starts on the airfield and drives the car profile", () => {
    expect(vehicleClass("landcruiser")).toBe("car");
    expect(surfaceSpawnKind("landcruiser")).toBe("airfield");
    expect(surfaceSpawnKind("speedboat")).toBe("dock");
    expect(inputProfileForSpawn("airfield")).toBe("car");
    expect(surfaceVehicleSpec("landcruiser").follow).toBe("surface");
  });

  it("starts at the access road head, between the last hangar and the fuel farm, facing out along the road", () => {
    const spawn = createSurfaceSpawn(world, "landcruiser");
    const airport = world.airport!;
    const head = airportRoadHead(world)!;
    expect(spawn.position.x).toBe(head.startX);
    expect(spawn.position.z).toBe(head.startZ);
    const local = worldToRunway(airport, spawn.position.x, spawn.position.z);
    // Off the runway and its shoulders, inside the perimeter fence (168 m).
    expect(local.across).toBeGreaterThan(airport.runwayWidth / 2 + airport.shoulderWidth + 50);
    expect(local.across).toBeLessThan(168);
    // Between the hangar row's last hangar and the fuel farm (along -17..17).
    const hangarRowEnd = airport.runwayLength * -0.12 + 52 + 17;
    expect(local.along).toBeGreaterThan(hangarRowEnd + 15);
    expect(local.along).toBeLessThan(-17 - 15);
    expect(spawn.position.y).toBeCloseTo(sampleGroundHeight(world, spawn.position.x, spawn.position.z), 6);
    // Facing out along the road, away from the runway, towards its opening in the fence.
    const ahead = worldToRunway(
      airport,
      spawn.position.x + Math.sin(spawn.heading) * 10,
      spawn.position.z + Math.cos(spawn.heading) * 10,
    );
    expect(ahead.across - local.across).toBeCloseTo(10, 6);
    expect(ahead.along).toBeCloseTo(airportRoadFenceOpening(world)!.along, 6);
    const recovery = createSurfaceRecoverySpawn(world, "landcruiser", 120, -340);
    expect(recovery.position).toEqual({ x: 120, y: sampleGroundHeight(world, 120, -340), z: -340 });
  });

  it("drives, steers and sits on the ground through the seam, and presents the car payload", () => {
    const spawn = createSurfaceSpawn(world, "landcruiser");
    const car = createSurfaceSimulator("landcruiser", { ...spawn, car: { gearbox: "manual", manualClutch: false } });
    expect(car).toBeInstanceOf(GroundVehicleSimulator);
    car.setEnvironment(environment(world));
    drive(car, 4, { accelerator: 1 });
    const moved = car.snapshot();
    const travelled = Math.hypot(moved.position.x - spawn.position.x, moved.position.z - spawn.position.z);
    expect(travelled).toBeGreaterThan(10);
    const ground = sampleGroundHeight(world, moved.position.x, moved.position.z);
    expect(Math.abs(moved.position.y - LC76_GEOMETRY.cgHeight - ground)).toBeLessThan(0.3);

    const state = surfaceVisualState(moved, undefined);
    if (moved.payload.kind !== "car") throw new Error("the car's snapshot carries the car payload");
    expect(moved.payload.gearbox).toBe("manual");
    expect(moved.payload.speed).toBeGreaterThan(5);
    expect(state.airspeed).toBe(Math.abs(moved.payload.speed));
    expect(state.vehicle).toBe(moved.payload);
    for (const field of ["wheelSteer", "wheelSpin", "wheelLoad", "wheelSlip", "wheelSinkage", "wheelSurface", "wheelWetness"] as const) {
      expect(moved.payload[field]).toHaveLength(4);
    }
    expect(moved.payload.axleHeave).toHaveLength(2);

    // Positive steer turns right, towards body +Z: the sim's heading decreases (D-6), as an aircraft's does.
    const before = surfaceVisualState(car.snapshot(), undefined).heading;
    drive(car, 1, { accelerator: 0.3, steer: 1 });
    const after = surfaceVisualState(car.snapshot(), undefined).heading;
    expect(((after - before + 540) % 360) - 180).toBeLessThan(-5);

    // The brake stops it and, held through the stop, holds it there.
    drive(car, 5, { brake: 1 });
    const held = car.snapshot().payload;
    if (held.kind !== "car") throw new Error("the car's snapshot carries the car payload");
    expect(Math.abs(held.speed)).toBeLessThan(0.05);
    expect(held.reversing).toBe(false);
    // Let up and held again at the stop, it backs the car up.
    drive(car, 0.2, {});
    drive(car, 4, { brake: 1 });
    const reversing = car.snapshot().payload;
    if (reversing.kind !== "car") throw new Error("the car's snapshot carries the car payload");
    expect(reversing.speed).toBeLessThan(0);
    expect(reversing.reversing).toBe(true);
  });

  it("cycles the headlights on L presses, counting only changes", () => {
    const car = new GroundVehicleSimulator(createSurfaceSpawn(world, "landcruiser"));
    car.setEnvironment(environment(world));
    // The first count seen is the baseline, whatever it is.
    drive(car, 0.1, { headlightPresses: 7 });
    expect(car.visualState().headlights).toBe("off");
    drive(car, 0.1, { headlightPresses: 8 });
    expect(car.visualState().headlights).toBe("dipped");
    drive(car, 0.1, { headlightPresses: 9 });
    expect(car.visualState().headlights).toBe("main");
    drive(car, 0.1, { headlightPresses: 10 });
    expect(car.visualState().headlights).toBe("off");
  });

  it("remembers the gearbox and the clutch option, and migrates settings without them", () => {
    expect(validateSettings({}).carGearbox).toBe("automatic");
    expect(validateSettings({}).carManualClutch).toBe(false);
    const manual = validateSettings({ vehicle: "landcruiser", carGearbox: "manual", carManualClutch: true });
    expect(manual.vehicle).toBe("landcruiser");
    expect(manual.carGearbox).toBe("manual");
    expect(manual.carManualClutch).toBe(true);
    expect(validateSettings({ carGearbox: "cvt" }).carGearbox).toBe("automatic");
  });
});
