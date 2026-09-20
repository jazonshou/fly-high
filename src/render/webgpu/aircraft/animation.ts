import type { FlightVisualState } from "@/src/game/types";
import type { AircraftKind } from "@/src/sim";

export interface AircraftAnimationPose {
  readonly rotorRadiansPerSecond: number;
  readonly starboardAileron: number;
  readonly portAileron: number;
  readonly elevator: number;
  readonly rudder: number;
  readonly noseSteering: number;
  readonly mainWheelRadiansPerSecond: number;
  readonly noseWheelRadiansPerSecond: number;
  readonly gearVisible: boolean;
  readonly gearScale: Readonly<{ x: number; y: number; z: number }>;
  readonly gearOffsetY: number;
  readonly gearDoorTravel: number;
  readonly speedBrake: number;
  /**
   * Trailing-edge-down rotation of every flap panel, in radians. Positive is
   * down, the same sense the ailerons and elevator use.
   */
  readonly flap: number;
}

/**
 * The travel each airframe's surfaces have, in radians at full deflection.
 *
 * A table rather than a branch: the shapes of the propeller and turbine poses
 * genuinely differ (one has a spinning propeller, the other retractable gear
 * and doors), but the deflections are just numbers and three aeroplanes'
 * worth of them do not belong in a conditional.
 */
interface SurfaceTravel {
  readonly aileron: number;
  readonly elevator: number;
  readonly rudder: number;
  readonly noseSteering: number;
  /** Full flap. The 150's barn-door 40 degrees is the type's signature. */
  readonly flap: number;
  /** Tyre radii, which set how fast the wheels appear to roll. */
  readonly mainWheelRadius: number;
  readonly noseWheelRadius: number;
}

const SURFACE_TRAVEL: Readonly<Record<AircraftKind, SurfaceTravel>> = Object.freeze({
  trainer: Object.freeze({
    aileron: 0.25,
    elevator: 0.3,
    rudder: 0.32,
    noseSteering: 0.24,
    flap: (40 * Math.PI) / 180,
    mainWheelRadius: 0.27,
    noseWheelRadius: 0.21,
  }),
  jet: Object.freeze({
    aileron: 0.22,
    elevator: 0.26,
    rudder: 0.28,
    noseSteering: 0.2,
    flap: (20 * Math.PI) / 180,
    mainWheelRadius: 0.3,
    noseWheelRadius: 0.24,
  }),
  bizjet: Object.freeze({
    // A large aeroplane's surfaces move through smaller angles, and its
    // nosewheel steers less at speed than a light aircraft's.
    aileron: 0.17,
    elevator: 0.22,
    rudder: 0.24,
    noseSteering: 0.16,
    flap: (30 * Math.PI) / 180,
    mainWheelRadius: 0.56,
    noseWheelRadius: 0.42,
  }),
});

export interface PropellerPresentation {
  readonly bladeOpacity: number;
  readonly discOpacity: number;
}

export const PROPELLER_DISC_CROSSFADE_START_RADIANS_PER_SECOND = 15;
export const PROPELLER_DISC_CROSSFADE_END_RADIANS_PER_SECOND = 35;

function finite(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, finite(value)));
}

/**
 * Below ~15 rad/s the eye resolves solid blades. Above that threshold the
 * exposure-integrated sweep takes over continuously; neither mesh nor the
 * propeller root is ever enabled/disabled as a phase-dependent strobe.
 */
export function resolvePropellerPresentation(
  radiansPerSecond: number,
): PropellerPresentation {
  const speed = Math.abs(finite(radiansPerSecond));
  const t = clamp(
    (speed - PROPELLER_DISC_CROSSFADE_START_RADIANS_PER_SECOND)
      / (
        PROPELLER_DISC_CROSSFADE_END_RADIANS_PER_SECOND
        - PROPELLER_DISC_CROSSFADE_START_RADIANS_PER_SECOND
      ),
    0,
    1,
  );
  const eased = t * t * (3 - 2 * t);
  return { bladeOpacity: 1 - eased, discOpacity: eased };
}

/**
 * Resolves the complete visual pose without touching Babylon state. Keeping
 * this pure makes handedness and actuator-sign regressions cheap to test.
 */
export function resolveAircraftAnimationPose(
  kind: AircraftKind,
  state: FlightVisualState,
): AircraftAnimationPose {
  const aileron = clamp(state.aileron, -1, 1);
  const elevator = clamp(state.elevator, -1, 1);
  const rudder = clamp(state.rudder, -1, 1);
  const brake = clamp(state.brake, 0, 1);
  const flaps = clamp(state.flaps, 0, 1);
  const travel = SURFACE_TRAVEL[kind] ?? SURFACE_TRAVEL.trainer;
  const groundSpeed = Math.hypot(
    finite(state.velocity.x),
    finite(state.velocity.z),
  );

  if (kind !== "trainer") {
    const gearTravel = clamp(state.gear, 0, 1);
    const easedGear = gearTravel * gearTravel * (3 - 2 * gearTravel);
    const wheelsRolling = state.onGround && gearTravel >= 0.98;
    return {
      rotorRadiansPerSecond: 10 + clamp(state.engineRpm, 0, 120) * 0.8,
      starboardAileron: -aileron * travel.aileron,
      portAileron: aileron * travel.aileron,
      elevator: -elevator * travel.elevator,
      // Right rudder swings the trailing edge to STARBOARD, which pushes the
      // tail to port and the nose right — the direction
      // `sim.body-axis-contract` pins for a positive pilot yaw. This was
      // negated, so the rudder answered every input backwards while the
      // nosewheel beside it steered the right way.
      rudder: rudder * travel.rudder,
      noseSteering: state.onGround ? -rudder * travel.noseSteering : 0,
      mainWheelRadiansPerSecond: wheelsRolling ? -groundSpeed / travel.mainWheelRadius : 0,
      noseWheelRadiansPerSecond: wheelsRolling ? -groundSpeed / travel.noseWheelRadius : 0,
      gearVisible: gearTravel > 0.012,
      gearScale: {
        x: 0.9 + easedGear * 0.1,
        y: 0.08 + easedGear * 0.92,
        z: 0.36 + easedGear * 0.64,
      },
      gearOffsetY: -0.24 * (1 - easedGear),
      gearDoorTravel: Math.sin(Math.PI * gearTravel) * 1.05,
      speedBrake: -brake * 0.68,
      flap: flaps * travel.flap,
    };
  }

  const normalizedRpm = clamp(state.engineRpm / 2_600, 0, 1.2);
  const wheelsRolling = state.onGround || finite(state.altitudeAgl, Infinity) < 0.35;
  return {
    // 123 rad/s at red line and zero at a stopped engine. The old artificial
    // 18 rad/s floor made a stopped propeller blur and made the A-4 solid
    // blade threshold unreachable.
    rotorRadiansPerSecond: normalizedRpm * 123,
    starboardAileron: -aileron * travel.aileron,
    portAileron: aileron * travel.aileron,
    elevator: -elevator * travel.elevator,
    // See the turbine note above: right rudder, trailing edge to starboard.
    rudder: rudder * travel.rudder,
    noseSteering: state.onGround ? -rudder * travel.noseSteering : 0,
    mainWheelRadiansPerSecond: wheelsRolling ? -groundSpeed / travel.mainWheelRadius : 0,
    noseWheelRadiansPerSecond: wheelsRolling ? -groundSpeed / travel.noseWheelRadius : 0,
    gearVisible: true,
    gearScale: { x: 1, y: 1, z: 1 },
    gearOffsetY: 0,
    gearDoorTravel: 0,
    speedBrake: 0,
    flap: flaps * travel.flap,
  };
}

/** Prevents a resumed tab from advancing rotors and wheels by several seconds. */
export function safeAircraftAnimationDelta(deltaSeconds: number): number {
  return Math.min(0.1, Math.max(0, finite(deltaSeconds)));
}
