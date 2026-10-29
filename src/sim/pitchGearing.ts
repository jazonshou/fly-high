/**
 * Speed-scheduled pitch gearing: how much of the pilot's pitch command reaches
 * the elevator, as dynamic pressure rises.
 *
 * Without it the stick drives the elevator one for one at every speed, and the
 * elevator's moment grows with dynamic pressure, so the same light tap that
 * nudges the nose at 230 kt slams it at 460 kt -- Jason's report on the F-16
 * (2026-10-27): "a light tap on W makes the plane shoot down".
 *
 * Above `kneeAirspeed` the command is scaled by knee / EAS, which is
 * sqrt(q_knee / q). That takes out HALF of the dynamic-pressure growth, not
 * all of it: the g a given stick asks for grows with airspeed instead of with
 * its square, so the aeroplane still feels faster when it is faster. A full
 * g-command law (the real F-16's flight control system) would scale by
 * q_knee / q and make every speed feel the same; that is a much bigger change
 * to how it flies, and the ask was for a slight one.
 *
 * Measured on the F-16 (knee 140 m/s) with the lightest keyboard tap
 * InputManager can make, at 1,000 m (scripts/pitch-tap-probe.mts):
 *
 *   EAS m/s   load factor added   peak pitch rate added
 *     115      0.47 g -> 0.47       8.8 -> 8.8 deg/s   (below the knee: identical)
 *     191      1.37   -> 1.02      20.0 -> 14.7
 *     238      2.72   -> 1.57      26.4 -> 16.4
 *     327      5.93   -> 3.01      32.2 -> 18.6
 *
 * A held stick keeps its authority: full deflection held at 3,000 m still
 * pulls 13 g at 215 m/s EAS and 23 g at 302 (24.5 before), because the sim has
 * no g-limiter and half the elevator is already past the usable 22 degrees.
 *
 * Below the knee nothing changes, bit for bit: take-off, the circuit, approach
 * and landing fly exactly as before. Pitch only: roll rate grows with airspeed
 * rather than its square, and the F-16's lightest roll tap banks it 9.6 degrees
 * at 115 m/s EAS and 12.3 at 238, so roll is left alone.
 */
export interface PitchGearing {
  /** Equivalent airspeed, m/s, up to which the stick moves the elevator one for one. */
  readonly kneeAirspeed: number;
  /** The smallest share of the pilot's command that ever reaches the elevator. */
  readonly floor: number;
}

/**
 * The share of the pilot's pitch command that reaches the elevator at this
 * equivalent airspeed: 1 below the knee or without gearing, then knee / EAS,
 * never below the floor. A non-finite airspeed reads as no gearing.
 */
export function pitchGearingFactor(
  gearing: Readonly<PitchGearing> | null,
  equivalentAirspeed: number,
): number {
  if (!gearing || !Number.isFinite(equivalentAirspeed) || equivalentAirspeed <= gearing.kneeAirspeed) {
    return 1;
  }
  return Math.max(gearing.floor, gearing.kneeAirspeed / equivalentAirspeed);
}
