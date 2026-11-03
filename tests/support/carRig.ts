import type { CarControlState, CarSetup } from "../../src/game/types";
import { GroundVehicleSimulator } from "../../src/sim/ground";
import type { GroundField, GroundPoint } from "../../src/sim/ground/terrainPatch";
import { NEUTRAL_BOAT_CONTROLS, NEUTRAL_CAR_CONTROLS } from "../../src/sim/surface";

/**
 * A test rig for the LandCruiser's physics: the car on an exact ground shape
 * with no world, so the surface is asphalt (the tyre model's reference) and
 * nothing streams. At heading 0 the car faces world +Z and its right side is
 * world -X.
 */

export const STEP = 1 / 120;

/** A ground shape: writes the height and its gradient at (`out.x`, `out.z`) into `out`. */
export type GroundShape = (out: GroundPoint) => void;

export function groundOf(shape: GroundShape): GroundField {
  return { evaluate: shape };
}

export const FLAT: GroundField = groundOf((out) => {
  out.height = 0;
  out.dhdx = 0;
  out.dhdz = 0;
});

/** A plane rising ahead of a car at heading 0 (along +Z) at `degrees`. */
export function slopeAhead(degrees: number): GroundField {
  const grade = Math.tan((degrees * Math.PI) / 180);
  return groundOf((out) => {
    const z = out.z;
    out.height = grade * z;
    out.dhdx = 0;
    out.dhdz = grade;
  });
}

/** Flat to `toe` along +Z, then a straight ramp at `degrees`: a sharp toe like a test ramp's. */
export function rampAhead(toe: number, degrees: number): GroundField {
  const grade = Math.tan((degrees * Math.PI) / 180);
  return groundOf((out) => {
    const z = out.z;
    const up = z > toe;
    out.height = up ? grade * (z - toe) : 0;
    out.dhdx = 0;
    out.dhdz = up ? grade : 0;
  });
}

export function car(setup: Partial<CarSetup> = {}, ground: GroundField = FLAT, heading = 0): GroundVehicleSimulator {
  return new GroundVehicleSimulator(
    {
      position: { x: 0, y: 0, z: 0 },
      heading,
      moored: false,
      car: { gearbox: setup.gearbox ?? "automatic", manualClutch: setup.manualClutch ?? false },
    },
    { ground },
  );
}

export function controls(sim: GroundVehicleSimulator, input: Partial<CarControlState>): void {
  sim.setControls({ assist: "pilot", boat: NEUTRAL_BOAT_CONTROLS, car: { ...NEUTRAL_CAR_CONTROLS, ...input } });
}

/** Hold `input` for `seconds`, calling `each` after every step. */
export function drive(
  sim: GroundVehicleSimulator,
  seconds: number,
  input: Partial<CarControlState>,
  each?: (sim: GroundVehicleSimulator) => void,
): void {
  controls(sim, input);
  const steps = Math.round(seconds / STEP);
  for (let i = 0; i < steps; i += 1) {
    sim.step(STEP);
    each?.(sim);
  }
}

/** Signed speed along the car's forward axis, m/s. */
export function speedOf(sim: GroundVehicleSimulator): number {
  const payload = sim.visualState();
  return payload.speed;
}

/** The car's heading the sim's way: atan2 of world forward's x and z (decreasing in a right turn). */
export function headingOf(sim: GroundVehicleSimulator): number {
  const q = sim.state.orientation;
  // Body +X rotated into the world.
  const fx = 1 - 2 * (q.y * q.y + q.z * q.z);
  const fz = 2 * (q.x * q.z - q.w * q.y);
  return Math.atan2(fx, fz);
}
