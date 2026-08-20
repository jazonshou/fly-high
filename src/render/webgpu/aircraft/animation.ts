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
}

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
  const groundSpeed = Math.hypot(
    finite(state.velocity.x),
    finite(state.velocity.z),
  );

  if (kind === "jet") {
    const gearTravel = clamp(state.gear, 0, 1);
    const easedGear = gearTravel * gearTravel * (3 - 2 * gearTravel);
    const wheelsRolling = state.onGround && gearTravel >= 0.98;
    return {
      rotorRadiansPerSecond: 10 + clamp(state.engineRpm, 0, 120) * 0.8,
      starboardAileron: -aileron * 0.22,
      portAileron: aileron * 0.22,
      elevator: -elevator * 0.26,
      rudder: -rudder * 0.28,
      noseSteering: state.onGround ? -rudder * 0.2 : 0,
      mainWheelRadiansPerSecond: wheelsRolling ? -groundSpeed / 0.3 : 0,
      noseWheelRadiansPerSecond: wheelsRolling ? -groundSpeed / 0.24 : 0,
      gearVisible: gearTravel > 0.012,
      gearScale: {
        x: 0.9 + easedGear * 0.1,
        y: 0.08 + easedGear * 0.92,
        z: 0.36 + easedGear * 0.64,
      },
      gearOffsetY: -0.24 * (1 - easedGear),
      gearDoorTravel: Math.sin(Math.PI * gearTravel) * 1.05,
      speedBrake: -brake * 0.68,
    };
  }

  const normalizedRpm = clamp(state.engineRpm / 2_600, 0, 1.2);
  const wheelsRolling = state.onGround || finite(state.altitudeAgl, Infinity) < 0.35;
  return {
    // 123 rad/s at red line and zero at a stopped engine. The old artificial
    // 18 rad/s floor made a stopped propeller blur and made the A-4 solid
    // blade threshold unreachable.
    rotorRadiansPerSecond: normalizedRpm * 123,
    starboardAileron: -aileron * 0.25,
    portAileron: aileron * 0.25,
    elevator: -elevator * 0.3,
    rudder: -rudder * 0.32,
    noseSteering: state.onGround ? -rudder * 0.24 : 0,
    mainWheelRadiansPerSecond: wheelsRolling ? -groundSpeed / 0.27 : 0,
    noseWheelRadiansPerSecond: wheelsRolling ? -groundSpeed / 0.21 : 0,
    gearVisible: true,
    gearScale: { x: 1, y: 1, z: 1 },
    gearOffsetY: 0,
    gearDoorTravel: 0,
    speedBrake: 0,
  };
}

/** Prevents a resumed tab from advancing rotors and wheels by several seconds. */
export function safeAircraftAnimationDelta(deltaSeconds: number): number {
  return Math.min(0.1, Math.max(0, finite(deltaSeconds)));
}
