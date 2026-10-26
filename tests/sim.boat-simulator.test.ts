import { describe, expect, it } from "vitest";
import { BoatSimulator, solveRestWaterline, type BoatEnvironment } from "../src/sim/boat";
import { createSurfaceSimulator, NEUTRAL_BOAT_CONTROLS, surfaceVisualState } from "../src/sim/surface";
import type { BoatControlState, FlightMode } from "../src/game/types";
import { MAX_BOAT_SPRAY_ROOTS } from "../src/game/types";
import { CalmWaterSurface } from "../src/sim/water";

/**
 * The boat on the shared vehicle seam: the contract the stand-in kept
 * (tests/vehicles.surface-base.test.ts), now held by the physics.
 */

const STEP = 1 / 120;

function environment(bedHeight: (x: number, z: number) => number): BoatEnvironment {
  return {
    water: new CalmWaterSurface(0, bedHeight),
    wind: { x: 0, y: 0, z: 0 },
    bedHeight,
    gravity: 9.80665,
  };
}

function controls(boat: Partial<BoatControlState> = {}, assist: FlightMode = "pilot") {
  return { assist, boat: { ...NEUTRAL_BOAT_CONTROLS, ...boat } };
}

function run(boat: BoatSimulator, seconds: number): void {
  for (let t = 0; t < seconds; t += STEP) boat.step(STEP);
}

const deep = environment(() => -30);

describe("boat simulator on the vehicle seam", () => {
  it("is what the worker gets for a speedboat", () => {
    const boat = createSurfaceSimulator("speedboat", { position: { x: 0, y: 0, z: 0 }, heading: 0, moored: true });
    expect(boat).toBeInstanceOf(BoatSimulator);
  });

  it("settles to its own draft from a still-water spawn, and does not move at rest", () => {
    const rest = solveRestWaterline();
    const lifted = new BoatSimulator({ position: { x: 12, y: 3, z: -7 }, heading: 1, moored: false });
    expect(lifted.state.position.y).toBeCloseTo(3 + rest.cgAboveWater, 9);
    const boat = new BoatSimulator({ position: { x: 12, y: 0, z: -7 }, heading: 1, moored: false });
    boat.setEnvironment(environment(() => -30));
    boat.setControls(controls());
    run(boat, 10);
    expect(Math.hypot(boat.state.position.x - 12, boat.state.position.z + 7)).toBeLessThan(1e-3);
    expect(boat.state.position.y).toBeCloseTo(rest.cgAboveWater, 4);
  });

  it("stays fast at the berth until the lever moves, then gets under way", () => {
    const boat = new BoatSimulator({ position: { x: 0, y: 0, z: 0 }, heading: Math.PI / 2, moored: true });
    boat.setEnvironment({ ...deep, wind: { x: 0, y: 0, z: 6 } });
    boat.setControls(controls());
    run(boat, 3);
    let snapshot = boat.snapshot();
    expect(snapshot.payload.moored).toBe(true);
    expect(Math.hypot(snapshot.position.x, snapshot.position.z)).toBeLessThan(0.1);

    boat.setControls(controls({ lever: 1 }));
    run(boat, 12);
    snapshot = boat.snapshot();
    expect(snapshot.payload.moored).toBe(false);
    expect(snapshot.payload.gear).toBe("forward");
    expect(snapshot.payload.speedThroughWater).toBeGreaterThan(15);
    // Heading pi/2 is east, +X, as `FlightTelemetry.heading` has it.
    expect(snapshot.position.x).toBeGreaterThan(50);
    expect(Math.abs(snapshot.position.z)).toBeLessThan(15);
  });

  it("takes the first mooring count it sees as a baseline, and only a change as a press", () => {
    const boat = new BoatSimulator({ position: { x: 0, y: 0, z: 0 }, heading: 0, moored: true });
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
    const boat = new BoatSimulator({ position: { x: 0, y: 0, z: 0 }, heading: Math.PI / 2, moored: false });
    boat.setEnvironment(shelf);
    boat.setControls(controls({ lever: 1 }));
    run(boat, 30);
    expect(boat.snapshot().crashed).toBe(true);
  });

  it("fills every field of the boat payload", () => {
    const boat = new BoatSimulator({ position: { x: 0, y: 0, z: 0 }, heading: 0, moored: false });
    boat.setEnvironment(deep);
    boat.setControls(controls({ lever: 1 }));
    run(boat, 8);
    const snapshot = boat.snapshot();
    const payload = snapshot.payload;
    for (const [key, value] of Object.entries(payload)) {
      if (typeof value === "number") expect(Number.isFinite(value), key).toBe(true);
    }
    expect(payload.kind).toBe("boat");
    expect(payload.planing).toBeGreaterThan(0.5);
    expect(payload.sprayRoots.length).toBe(MAX_BOAT_SPRAY_ROOTS * 4);
    expect(payload.sprayRootCount).toBeGreaterThan(0);
    expect(payload.sprayRootCount).toBeLessThanOrEqual(MAX_BOAT_SPRAY_ROOTS);
    expect(snapshot.engineRpm).toBeGreaterThan(4_000);
    expect(snapshot.throttle).toBeGreaterThan(0.5);
    expect(snapshot.throttle).toBeLessThanOrEqual(1);
    const state = surfaceVisualState(snapshot, undefined);
    expect(state.airspeed).toBe(payload.speedThroughWater);
    expect(state.vehicle).toBe(payload);
  });
});
