import { describe, expect, it } from "vitest";
import { createSurfaceSpawn } from "../src/game/surfaceSpawn";
import type { FlightVisualState, PersonControlState } from "../src/game/types";
import { ColliderWorld } from "../src/sim/colliders";
import { CAR_AIRPORT_COLLIDER_GROUP } from "../src/sim/ground/carColliders";
import { MARINA_COLLIDER_GROUP } from "../src/sim/marina/colliders";
import { createPersonSimulator } from "../src/sim/person";
import { PARKED_CAR_COLLIDER_GROUP, WalkingSession, type WalkingStart } from "../src/sim/person/walkingSession";
import {
  createSurfaceSimulator,
  flightAnglesOf,
  NEUTRAL_BOAT_CONTROLS,
  NEUTRAL_CAR_CONTROLS,
  NEUTRAL_PERSON_CONTROLS,
  type SurfaceVehicleControls,
  type SurfaceVehicleEnvironment,
} from "../src/sim/surface";
import { sampleGroundContact, sampleGroundHeight } from "../src/sim/terrainGrid";
import { CalmWaterSurface } from "../src/sim/water";
import { CAR_SEATING, PERSON } from "../src/vehicles/person";
import { createWorld, type WorldDefinition } from "../src/world";

/**
 * The walking session (the walking plan, "Getting in and out of the car"):
 * the person and the car in one car session, exactly one driven, the parked
 * car asleep as a box, and the interact press getting in and out.
 */

const STEP = 1 / 120;

function environment(world: WorldDefinition, colliders: ColliderWorld): SurfaceVehicleEnvironment {
  const bed = (x: number, z: number) => sampleGroundHeight(world, x, z);
  return {
    water: new CalmWaterSurface(world.seaLevel, bed),
    wind: { x: 0, y: 0, z: 0 },
    bedHeight: bed,
    groundContact: (x, z, target) => sampleGroundContact(world, x, z, target),
    world,
    colliders,
    gravity: 9.80665,
  };
}

class Rig {
  readonly colliders = new ColliderWorld();
  readonly session: WalkingSession;
  interact = 0;
  person: PersonControlState = { ...NEUTRAL_PERSON_CONTROLS };
  switches = 0;

  constructor(readonly world: WorldDefinition, start: WalkingStart) {
    const spawn = createSurfaceSpawn(world, "landcruiser");
    const car = createSurfaceSimulator("landcruiser", { ...spawn, car: { gearbox: "automatic", manualClutch: false } });
    const walker = createPersonSimulator({ position: spawn.position, heading: spawn.heading });
    this.session = new WalkingSession(car, walker, start, environment(world, this.colliders));
  }

  run(seconds: number): void {
    const controls: SurfaceVehicleControls = {
      assist: "pilot",
      boat: NEUTRAL_BOAT_CONTROLS,
      ...(this.session.driven === "car" ? { car: NEUTRAL_CAR_CONTROLS } : {}),
      person: this.person,
    };
    for (let t = 0; t < seconds; t += STEP) {
      if (this.session.step(STEP, controls, this.interact)) this.switches += 1;
    }
  }

  press(): void {
    this.interact += 1;
  }

  state(): FlightVisualState {
    return this.session.visualState(undefined);
  }

  /** A world-axis move toward a point, unit length. */
  moveToward(x: number, z: number): void {
    const position = this.session.person.state.position;
    const dx = x - position.x;
    const dz = z - position.z;
    const length = Math.hypot(dx, dz) || 1;
    this.person = { ...this.person, moveX: dx / length, moveZ: dz / length };
  }

  stop(): void {
    this.person = { ...NEUTRAL_PERSON_CONTROLS };
  }
}

describe("walking session", () => {
  const world = createWorld(0x51a7e);

  it("keeps the parked car's box in a collider group of its own", () => {
    expect(PARKED_CAR_COLLIDER_GROUP).not.toBe(MARINA_COLLIDER_GROUP);
    expect(PARKED_CAR_COLLIDER_GROUP).not.toBe(CAR_AIRPORT_COLLIDER_GROUP);
    expect(PARKED_CAR_COLLIDER_GROUP).toBeLessThan(1_000_000);
  });

  it("starts in the driver's seat, gets out by the driver's door, and stands clear of the car", () => {
    const rig = new Rig(world, "car");
    rig.run(0.05);
    rig.run(3);
    let state = rig.state();
    expect(state.walking?.driven).toBe("car");
    expect(state.vehicle?.kind).toBe("car");
    expect(state.walking?.car).toBeNull();
    expect(state.walking?.prompt).toEqual({ action: "getOut", ready: true, reason: null });

    rig.press();
    rig.run(STEP);
    expect(rig.switches).toBe(1);
    state = rig.state();
    expect(state.walking?.driven).toBe("person");
    expect(state.vehicle?.kind).toBe("person");
    if (state.vehicle?.kind !== "person") throw new Error("person payload");
    expect(state.vehicle.mode).toBe("board");
    expect(state.vehicle.boarding?.action).toBe("getOut");
    expect(state.walking?.car?.vehicle?.kind).toBe("car");

    rig.run(0.4);
    expect(rig.state().walking?.doors[0]).toBeGreaterThan(0.9);
    rig.run(PERSON.getOutSeconds);
    state = rig.state();
    if (state.vehicle?.kind !== "person") throw new Error("person payload");
    expect(state.vehicle.boarding).toBeNull();
    expect(state.walking?.doors).toEqual([0, 0]);
    // On the car's right (body +Z), clear of its side, facing away from it.
    const car = rig.session.car.state;
    const offset = {
      x: state.position.x - car.position.x,
      z: state.position.z - car.position.z,
    };
    const right = flightAnglesOf(car.orientation).heading - Math.PI / 2;
    const across = offset.x * Math.sin(right) + offset.z * Math.cos(right);
    expect(across).toBeCloseTo(CAR_SEATING.doorStand.right, 1);
    const facing = (state.heading * Math.PI) / 180;
    expect(Math.cos(facing - right)).toBeGreaterThan(0.99);
  });

  it("lets the parked car fall asleep as a box the walker cannot walk through", () => {
    const rig = new Rig(world, "car");
    rig.run(3);
    rig.press();
    rig.run(PERSON.getOutSeconds + 0.1);
    rig.run(2);
    expect(rig.colliders.size).toBe(1);
    // Walk straight at the car's centre from its right side.
    const car = rig.session.car.state.position;
    rig.moveToward(car.x, car.z);
    rig.run(3);
    const person = rig.session.person.state.position;
    expect(Math.hypot(person.x - car.x, person.z - car.z)).toBeGreaterThan(0.93);
    expect(rig.colliders.removeGroup(PARKED_CAR_COLLIDER_GROUP)).toBe(1);
  });

  it("gets back in within reach of a door, drives again and drops the box", () => {
    const rig = new Rig(world, "car");
    rig.run(3);
    rig.press();
    rig.run(PERSON.getOutSeconds + 0.1);
    // Step away, then come back to the door's spot.
    const start = { ...rig.session.person.state.position };
    rig.person = { ...NEUTRAL_PERSON_CONTROLS, moveX: 1, moveZ: 0 };
    rig.run(2);
    expect(rig.state().walking?.prompt?.ready ?? false).toBe(false);
    for (let i = 0; i < 400; i += 1) {
      const p = rig.session.person.state.position;
      if (Math.hypot(p.x - start.x, p.z - start.z) < 0.3) break;
      rig.moveToward(start.x, start.z);
      rig.run(STEP * 4);
    }
    rig.stop();
    rig.run(0.5);
    expect(rig.state().walking?.prompt).toEqual({ action: "getIn", ready: true, reason: null });
    expect(rig.colliders.size).toBe(1);
    const switches = rig.switches;
    rig.press();
    rig.run(PERSON.getInSeconds / 2);
    const boarding = rig.state();
    if (boarding.vehicle?.kind !== "person") throw new Error("person payload");
    expect(boarding.vehicle.boarding?.action).toBe("getIn");
    rig.run(PERSON.getInSeconds / 2 + 0.05);
    expect(rig.switches).toBe(switches + 1);
    const state = rig.state();
    expect(state.walking?.driven).toBe("car");
    expect(rig.colliders.size).toBe(0);
  });

  it("starts on foot beside the driver's door once the car has settled", () => {
    const rig = new Rig(world, "foot");
    rig.run(0.5);
    const state = rig.state();
    expect(state.walking?.driven).toBe("person");
    expect(state.vehicle?.kind).toBe("person");
    const car = rig.session.car.state;
    const person = state.position;
    const distance = Math.hypot(person.x - car.position.x, person.z - car.position.z);
    expect(distance).toBeGreaterThan(1.2);
    expect(distance).toBeLessThan(1.6);
    expect(person.y).toBeCloseTo(sampleGroundHeight(world, person.x, person.z), 1);
    expect(state.walking?.prompt?.action).toBe("getIn");
  });
});
