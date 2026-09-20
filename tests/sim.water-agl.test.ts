import { describe, expect, it } from "vitest";
import { FlightSimulator, pilotSurfaceClearance } from "../src/sim";
import type { EnvironmentInput } from "../src/sim";

/**
 * Pilot-facing AGL over water.
 *
 * Jason's report: over water the AGL read to the SEABED, which over open ocean
 * is 50-105 m below the surface the aeroplane is actually flying over (and up
 * to ~4 km on the abyssal profile). His scope decision: display only, and the
 * number goes NEGATIVE below the surface.
 *
 * The two things these tests exist to hold apart:
 *
 *  - the READING changes, and is signed over water;
 *  - the PHYSICS does not. Contact, friction, impact and crash keep sampling
 *    the real terrain, so an aeroplane flown into the sea still passes through
 *    the surface and continues to the bottom exactly as it did before. That is
 *    deliberate (Jason: "Hitting water shouldn't count as a crash for now -
 *    nothing should change about impact"), so the last test here asserts the
 *    non-change rather than leaving it to inspection.
 */

const SEA_LEVEL = 0;
/** Open ocean: the bed is far below the surface, which is the whole defect. */
const SEABED_HEIGHT = -105;
const LAND_HEIGHT = 240;

function environmentOver(surfaceHeight: number, seaLevel?: number): EnvironmentInput {
  return {
    terrain: () => ({ height: surfaceHeight, friction: surfaceHeight <= SEA_LEVEL ? 0.05 : 0.86 }),
    terrainHeight: () => surfaceHeight,
    ...(seaLevel === undefined ? {} : { seaLevel }),
  };
}

function simulatorAt(y: number, environment: EnvironmentInput): FlightSimulator {
  return new FlightSimulator({
    spawn: { position: { x: 0, y, z: 0 }, airspeed: 60 },
    environment,
  });
}

describe("AGL is measured to the water surface", () => {
  it("reads clearance to the SURFACE over open sea, not to the bed", () => {
    const height = 120;
    const telemetry = simulatorAt(height, environmentOver(SEABED_HEIGHT, SEA_LEVEL)).telemetry();
    // 120 m over the water, not 225 m over the bed. The contact points hang a
    // little below the CG, so this is a band rather than an equality.
    expect(telemetry.altitudeAgl).toBeGreaterThan(height - 4);
    expect(telemetry.altitudeAgl).toBeLessThanOrEqual(height);
    expect(telemetry.altitudeAgl).toBeLessThan(height - SEABED_HEIGHT - 50);
  });

  it("goes NEGATIVE below the surface, by how far below", () => {
    const depth = 30;
    const telemetry = simulatorAt(-depth, environmentOver(SEABED_HEIGHT, SEA_LEVEL)).telemetry();
    expect(telemetry.altitudeAgl).toBeLessThan(0);
    expect(telemetry.altitudeAgl).toBeGreaterThan(-depth - 4);
    expect(telemetry.altitudeAgl).toBeLessThanOrEqual(-depth);
    // Not the bed: 75 m above it, but 30 m UNDER the water.
    expect(telemetry.altitudeAgl).not.toBeGreaterThan(0);
  });

  it("is unchanged over land, and still clamps to zero in ground contact", () => {
    const withWater = simulatorAt(LAND_HEIGHT + 50, environmentOver(LAND_HEIGHT, SEA_LEVEL));
    const withoutWater = simulatorAt(LAND_HEIGHT + 50, environmentOver(LAND_HEIGHT));
    expect(withWater.telemetry().altitudeAgl).toBe(withoutWater.telemetry().altitudeAgl);
    expect(withWater.telemetry().altitudeAgl).toBeGreaterThan(45);

    // Sitting on the ground: exactly zero, water datum or not. The clamp is
    // what keeps a compressed tyre from reading a small negative on a runway.
    const parked = simulatorAt(LAND_HEIGHT, environmentOver(LAND_HEIGHT, SEA_LEVEL));
    expect(parked.telemetry().altitudeAgl).toBe(0);
  });

  it("is continuous across the shoreline", () => {
    // Walk the terrain up through the waterline at a fixed altitude. Nothing
    // may step: as the bed rises to meet the datum the two clearances converge.
    const altitude = 60;
    const readings = [-40, -10, -2, -0.5, 0, 0.5, 2, 10, 40].map((terrain) =>
      simulatorAt(altitude, environmentOver(terrain, SEA_LEVEL)).telemetry().altitudeAgl);
    for (let i = 1; i < readings.length; i += 1) {
      const step = Math.abs(readings[i]! - readings[i - 1]!);
      const terrainStep = Math.abs([-40, -10, -2, -0.5, 0, 0.5, 2, 10, 40][i]!
        - [-40, -10, -2, -0.5, 0, 0.5, 2, 10, 40][i - 1]!);
      expect(step, `step between reading ${i - 1} and ${i}`).toBeLessThanOrEqual(terrainStep + 1e-9);
    }
    // Below the waterline the reading is the water's and does not move at all
    // as the bed drops away underneath it.
    expect(readings[0]).toBe(readings[1]);
    expect(readings[1]).toBe(readings[2]);
    // Above it, the terrain takes over and the reading falls with the rising bed.
    expect(readings[8]).toBeLessThan(readings[6]!);
  });

  it("reads zero when crashed, water or no water", () => {
    const simulator = simulatorAt(-30, environmentOver(SEABED_HEIGHT, SEA_LEVEL));
    simulator.state.crashed = true;
    expect(simulator.telemetry().altitudeAgl).toBe(0);
  });

  it("takes the water datum from the environment rather than assuming zero", () => {
    // WorldDefinition.seaLevel is `options.seaLevel ?? 0`, so a world may put
    // the sea anywhere. Nothing may hardcode 0.
    const raised = 400;
    const telemetry = simulatorAt(raised + 25, environmentOver(-50, raised)).telemetry();
    expect(telemetry.altitudeAgl).toBeGreaterThan(20);
    expect(telemetry.altitudeAgl).toBeLessThanOrEqual(25);
  });

  it("changes NOTHING for an environment that supplies no water datum", () => {
    // Every existing caller -- DEFAULT_ENVIRONMENT, and every test that builds
    // an environment out of terrain samplers alone -- is untouched to the bit.
    for (const [altitude, terrain] of [[120, SEABED_HEIGHT], [290, LAND_HEIGHT], [-30, SEABED_HEIGHT]]) {
      const reading = simulatorAt(altitude!, environmentOver(terrain!)).telemetry().altitudeAgl;
      expect(reading).toBeGreaterThanOrEqual(0);
      expect(reading).toBeGreaterThan(altitude! - terrain! - 5);
    }
  });
});

describe("the water datum is display-only: physics still samples the bed", () => {
  it("lets an aircraft fly through the surface without contact, impact or crash", () => {
    // The aeroplane starts 20 m UNDER the water and 85 m above the bed. If the
    // display datum had leaked into the contact path, this is exactly where it
    // would show: a surface at 0 would be inside the airframe.
    const simulator = simulatorAt(-20, environmentOver(SEABED_HEIGHT, SEA_LEVEL));
    for (let step = 0; step < 60; step += 1) simulator.step(1 / 60);
    expect(simulator.state.crashed).toBe(false);
    expect(simulator.state.onGround).toBe(false);
    expect(simulator.telemetry().altitudeAgl).toBeLessThan(0);
    // Still airborne and still above the bed, i.e. the sea is not a floor.
    expect(simulator.state.position.y).toBeGreaterThan(SEABED_HEIGHT);
  });

  it("puts the aircraft on the BED, not on the surface, when it settles", () => {
    // A shallow bed just under the waterline: with gear down and a gentle
    // descent the wheels must reach the BED and stop there. If AGL's datum had
    // leaked into contact, it would stop at 0.
    const bed = -6;
    const simulator = simulatorAt(bed + 30, environmentOver(bed, SEA_LEVEL));
    simulator.setControls({ ...simulator.controls, throttle: 0 });
    for (let step = 0; step < 60 * 30; step += 1) simulator.step(1 / 60);
    // It came to rest UNDER the water (y < 0) and ON the bed (just above -6).
    // Measured -4.3 m: the suspension holds the wheels a little off the plane.
    expect(simulator.state.position.y).toBeLessThan(0);
    expect(simulator.state.position.y).toBeGreaterThan(bed - 3);
    expect(simulator.state.onGround).toBe(true);
    // It arrives hard enough to crash, which is the pre-existing behaviour and
    // is exactly what Jason asked to leave alone ("nothing should change about
    // impact") -- the sea did not stop it, the bed did. A crashed aircraft
    // reports 0 whatever is under it, pinned separately above, so there is no
    // AGL assertion here: the evidence that the display datum stayed out of the
    // physics is WHERE IT STOPPED, not what the instrument says afterwards.
    expect(simulator.state.crashed).toBe(true);
  });
});

describe("the rule is ONE authority, shared with the terrain viewer", () => {
  // src/game/freeFly.ts computes the viewer HUD's own AGL from the camera
  // rather than from contact points, and it calls this same function. Before
  // W-12 it had its own arithmetic, which is how the viewer came to show a
  // height above the seabed in the screenshot that started this. The
  // controller itself needs a DOM and cannot be built in this suite, so the
  // shared rule is pinned here and freeFly is pinned by calling it.
  it("clamps the terrain side and signs the water side", () => {
    // No datum: exactly the old behaviour, clamped, for every input.
    expect(pilotSurfaceClearance(120, 120, undefined)).toBe(120);
    expect(pilotSurfaceClearance(-3, -3, undefined)).toBe(0);

    // Over open sea: the water wins, because the bed is far below it.
    expect(pilotSurfaceClearance(225, 120, 0)).toBe(120);
    // Under the surface: signed, and it is the water that is reported.
    expect(pilotSurfaceClearance(75, -30, 0)).toBe(-30);
    // Over land: the terrain wins and the clamp holds.
    expect(pilotSurfaceClearance(50, 290, 0)).toBe(50);
    expect(pilotSurfaceClearance(0, 240, 0)).toBe(0);
    expect(pilotSurfaceClearance(-0.02, 240, 0)).toBe(0);
    // A world whose sea is not at zero.
    expect(pilotSurfaceClearance(450, 425, 400)).toBe(25);
  });

  it("is continuous where the two sides meet", () => {
    // Walk a terrain height up through the waterline at a fixed altitude and
    // read the rule directly: no step, and the water half is flat.
    const altitude = 60;
    const readings = [-40, -10, -0.5, 0, 0.5, 10, 40].map((terrain) =>
      pilotSurfaceClearance(altitude - terrain, altitude, 0));
    expect(readings.slice(0, 4)).toEqual([60, 60, 60, 60]);
    expect(readings[4]).toBeCloseTo(59.5, 9);
    expect(readings[6]).toBeCloseTo(20, 9);
    for (let i = 1; i < readings.length; i += 1) {
      expect(readings[i]!).toBeLessThanOrEqual(readings[i - 1]!);
    }
  });
});
