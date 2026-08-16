import { clamp } from "./math";
import type { FlightControls, FlightState, FlightTelemetry } from "./types";

export type StabilityAssistMode = "scenic" | "pilot" | "unassisted";

const DEG_TO_RAD = Math.PI / 180;

function copyControls(out: FlightControls, requested: FlightControls): void {
  out.throttle = requested.throttle;
  out.pitch = requested.pitch;
  out.roll = requested.roll;
  out.yaw = requested.yaw;
  out.trim = requested.trim;
  out.flaps = requested.flaps;
  out.brake = requested.brake;
  out.gear = requested.gear;
}

/**
 * Converts pilot commands into surface commands for the two assisted modes.
 *
 * Scenic mode is an attitude-command controller: holding a direction asks for
 * a predictable bank/pitch and releasing the controls recentres the airplane.
 * Pilot mode retains direct surface control while adding only rate damping and
 * a small amount of turn coordination. Unassisted is a byte-for-byte pass
 * through. Scenic mode can optionally hold a runway heading while the pilot is
 * not commanding rudder; Pilot and Unassisted always leave ground steering
 * direct, and any Scenic rudder input immediately overrides the hold.
 */
export function applyFlightAssistance(
  out: FlightControls,
  mode: StabilityAssistMode,
  requested: FlightControls,
  state: FlightState,
  telemetry: FlightTelemetry,
  groundHeadingTarget?: number,
): FlightControls {
  copyControls(out, requested);
  if (mode === "unassisted") return out;

  if (state.onGround) {
    if (
      mode === "scenic" &&
      Number.isFinite(groundHeadingTarget) &&
      telemetry.groundSpeed > 1.5 &&
      Math.abs(requested.yaw) < 0.04
    ) {
      const headingError = Math.atan2(
        Math.sin((groundHeadingTarget ?? telemetry.heading) - telemetry.heading),
        Math.cos((groundHeadingTarget ?? telemetry.heading) - telemetry.heading),
      );
      out.yaw = clamp(headingError * 1.65 - state.angularVelocity.y * 0.42, -0.5, 0.5);
    }
    return out;
  }

  const pitchRate = state.angularVelocity.z;
  const rollRate = -state.angularVelocity.x;
  const yawRate = state.angularVelocity.y;

  if (mode === "pilot") {
    out.pitch = clamp(requested.pitch - pitchRate * 0.16, -1, 1);
    out.roll = clamp(requested.roll - rollRate * 0.14, -1, 1);
    out.yaw = clamp(
      requested.yaw + requested.roll * 0.1 - yawRate * 0.08,
      -1,
      1,
    );
    return out;
  }

  const speedAuthority = clamp((telemetry.indicatedAirspeed - 18) / 12, 0.35, 1);
  const targetBank = requested.roll * 42 * DEG_TO_RAD * speedAuthority;
  const neutralPitch = 2.5 * DEG_TO_RAD;
  let targetPitch = neutralPitch + requested.pitch * 14 * DEG_TO_RAD;
  const stallIncidence = Math.max(
    0,
    Math.abs(telemetry.angleOfAttack) - 11.5 * DEG_TO_RAD,
  );
  const stallRecovery = clamp(stallIncidence / (7 * DEG_TO_RAD), 0, 1);
  if (stallRecovery > 0 && telemetry.angleOfAttack > 0) {
    targetPitch = Math.min(targetPitch, (2.5 - stallRecovery * 8) * DEG_TO_RAD);
  }

  const rollCommand = (targetBank - telemetry.bank) * 1.7 - rollRate * 0.48;
  const pitchCommand =
    (targetPitch - telemetry.pitch) * 1.85 -
    pitchRate * 0.52 -
    stallRecovery * 0.32;
  const coordinatedYaw = Math.sin(telemetry.bank) * 0.22;

  out.roll = clamp(rollCommand, -0.78, 0.78);
  out.pitch = clamp(pitchCommand, -0.72, 0.72);
  out.yaw = clamp(
    requested.yaw * 0.72 + coordinatedYaw - yawRate * 0.1,
    -0.72,
    0.72,
  );
  return out;
}
