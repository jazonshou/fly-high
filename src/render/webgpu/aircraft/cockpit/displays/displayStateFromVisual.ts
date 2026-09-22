import type { FlightVisualState } from "@/src/game/types";
import {
  FEET_PER_METRE,
  FEET_PER_MINUTE_PER_METRE_PER_SECOND,
  KNOTS_PER_METRE_PER_SECOND,
} from "../instrumentMappings";
import type { DisplayState } from "./displayState";

/**
 * The one conversion between the simulator's state and what a page draws.
 *
 * `displayState.ts` says it outright -- the pages take display units and somebody converts once --
 * and this is that somebody. Pure arithmetic: no Babylon, no canvas, no meshes.
 *
 * THE UNITS ARE THE CODE'S, AND EVERY ONE IS CHECKED AGAINST ITS PRODUCER rather than against a
 * brief. `tests/render.cockpit-display-state.test.ts` holds each field to the number the HUD renders
 * for the same state, so a factor that drifts from the HUD's fails there.
 *
 * THE ONE THAT NEARLY WENT WRONG, recorded because it is invisible once it is wrong: heading, pitch
 * and bank are ALREADY DEGREES here. They are RADIANS in the simulator's own telemetry
 * (`src/sim/simulation.ts` builds them with `Math.atan2`/`Math.asin`), and the brief for this work
 * said "telemetry.heading is RADIANS" -- true of THAT type, and false of this one.
 * `updateVisualAnglesFromOrientation` (`src/game/SimulationClient.ts`) converts on the way into
 * `FlightVisualState`: heading is `(atan2(...) * 180 / PI + 360) % 360`, i.e. degrees in [0, 360),
 * and pitch and bank are degrees either side of zero. The HUD agrees: it formats heading with
 * `((heading % 360) + 360) % 360`, which is only meaningful for degrees. Converting "from radians"
 * here would have scaled heading by 57.3 and wrapped it into nonsense, and every test written
 * around the same assumption would have passed. See `instrumentMappings.ts`, which reads the same
 * fields the same way, and the findings doc's units table.
 */

/** The airframe constants a display needs that the state does not carry. */
export interface DisplayAirframe {
  /** How many N1 gauges the EICAS draws. The 747 has four. */
  readonly engineCount: number;
  /** Trailing-edge-down travel at full flap, DEGREES (the 747's is 30; `animation.ts`'s own table). */
  readonly fullFlapDegrees: number;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}
/** A non-finite reading must not poison a whole page of drawing; it reads as zero, as the dials do. */
function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

/**
 * Everything the pages draw, from one visual state.
 *
 * `n1Percent` repeats ONE number: the simulator models a single `engineRpm` (a percentage on the
 * jets) and no per-engine state, so four gauges that differed would be drawing fiction.
 * `spoilers` comes from the BRAKE, which is what `animation.ts` drives the wings from (ground
 * spoilers armed by it on the wheels, flight speed brake in the air); the two cases differ in the
 * radians the animation scales it to, not in the fraction a display annunciates.
 */
export function displayStateFromVisual(state: FlightVisualState, airframe: DisplayAirframe): DisplayState {
  const velocityX = finiteOr(state.velocity?.x ?? 0, 0);
  const velocityZ = finiteOr(state.velocity?.z ?? 0, 0);
  const n1 = finiteOr(state.engineRpm, 0);
  return {
    // already degrees: see the note above, and do NOT "convert from radians"
    bankDeg: finiteOr(state.bank, 0),
    pitchDeg: finiteOr(state.pitch, 0),
    headingDeg: ((finiteOr(state.heading, 0) % 360) + 360) % 360,
    airspeedKt: finiteOr(state.airspeed, 0) * KNOTS_PER_METRE_PER_SECOND,
    groundSpeedKt: Math.hypot(velocityX, velocityZ) * KNOTS_PER_METRE_PER_SECOND,
    // MSL, not the HUD tape's height above the ground
    altitudeFtMsl: finiteOr(state.altitude, 0) * FEET_PER_METRE,
    verticalSpeedFpm: finiteOr(state.verticalSpeed, 0) * FEET_PER_MINUTE_PER_METRE_PER_SECOND,
    n1Percent: Array.from({ length: airframe.engineCount }, () => n1),
    // 1 is down-and-locked; anything less is in transit, and a display that says DOWN then lies
    gearDown: finiteOr(state.gear, 0) >= 0.99,
    flapDeg: clamp(finiteOr(state.flaps, 0), 0, 1) * airframe.fullFlapDegrees,
    spoilers: clamp(finiteOr(state.brake, 0), 0, 1),
    throttlePercent: clamp(finiteOr(state.throttle, 0), 0, 1) * 100,
  };
}
