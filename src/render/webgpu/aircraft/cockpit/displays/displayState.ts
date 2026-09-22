import type { FlightVisualState } from "@/src/game/types";
import {
  FEET_PER_METRE,
  FEET_PER_MINUTE_PER_METRE_PER_SECOND,
  KNOTS_PER_METRE_PER_SECOND,
} from "../instrumentMappings";

/**
 * What the six flight-deck displays read, from the `FlightVisualState` the visual already receives,
 * in the units a Boeing display shows. Pure arithmetic: no Babylon, no meshes, no canvas.
 *
 * THE UNITS ARE THE CODE'S, AND EVERY ONE IS CHECKED AGAINST ITS PRODUCER rather than against a
 * brief. `tests/render.cockpit-display-state.test.ts` holds each field to the number the HUD renders
 * for the same state, so a factor that drifts from the HUD's fails there.
 *
 * THE ONE THAT NEARLY WENT WRONG, recorded because it is invisible once it is wrong: heading, pitch
 * and bank are ALREADY DEGREES here. They are RADIANS in the simulator's own telemetry
 * (`src/sim/simulation.ts` builds them with `Math.atan2`/`Math.asin`), and the brief for this work
 * said "telemetry.heading is RADIANS" — true of THAT type, and false of this one.
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

export interface DisplayState {
  /** Degrees, +right wing down. */
  readonly bankDeg: number;
  /** Degrees, +nose up. */
  readonly pitchDeg: number;
  /** Knots, from EQUIVALENT airspeed. */
  readonly airspeedKt: number;
  /** Knots over the ground: the horizontal part of the world velocity. */
  readonly groundSpeedKt: number;
  /** Feet above MEAN SEA LEVEL, not above the ground. */
  readonly altitudeFtMsl: number;
  /** Feet a minute, +up. */
  readonly verticalSpeedFpm: number;
  /** Degrees, [0, 360). */
  readonly headingDeg: number;
  /**
   * Per engine, percent. There is ONE engine number in the state (`engineRpm`, a percentage on the
   * jets), so all four read alike: the simulator does not model engines separately, and a display
   * that invented four different numbers would be drawing fiction.
   */
  readonly n1Percent: readonly number[];
  /** True only at down-and-locked. `gear` is the travel fraction, and 1 is locked. */
  readonly gearDown: boolean;
  /** Degrees of trailing-edge-down flap. */
  readonly flapDeg: number;
  /**
   * Spoiler deployment, 0 to 1. `FlightVisualState` has no spoiler field: the wings are driven from
   * the BRAKE (`animation.ts` arms the ground spoilers with it on the wheels and uses it as the
   * flight speed brake in the air), so this is that same commanded fraction. The two cases differ
   * only in the radians the animation scales it to, not in the fraction a display would annunciate.
   */
  readonly spoilers: number;
  /** Percent of full throttle. */
  readonly throttlePercent: number;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}
/** A non-finite reading must not poison a whole page of drawing; it reads as zero, as the dials do. */
function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

/** Everything the six pages draw, from one visual state. */
export function displayStateFrom(state: FlightVisualState, airframe: DisplayAirframe): DisplayState {
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
    altitudeFtMsl: finiteOr(state.altitude, 0) * FEET_PER_METRE,
    verticalSpeedFpm: finiteOr(state.verticalSpeed, 0) * FEET_PER_MINUTE_PER_METRE_PER_SECOND,
    n1Percent: Array.from({ length: airframe.engineCount }, () => n1),
    gearDown: finiteOr(state.gear, 0) >= 0.99,
    flapDeg: clamp(finiteOr(state.flaps, 0), 0, 1) * airframe.fullFlapDegrees,
    spoilers: clamp(finiteOr(state.brake, 0), 0, 1),
    throttlePercent: clamp(finiteOr(state.throttle, 0), 0, 1) * 100,
  };
}
