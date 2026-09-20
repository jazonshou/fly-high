import { clamp } from "./math";
import { TRIM_ELEVATOR_AUTHORITY } from "./simulation";

/**
 * Handing the aeroplane to the player: putting the elevator that is already
 * flying it onto their trim, instead of snapping the surfaces to neutral.
 *
 * Jason asked for this after the Scenic hold landed: *"Sure let's do that"*.
 *
 * **The problem.** During the menu the attract supervisor flies the aeroplane
 * by writing `controls.pitch`, so the elevator it needs lives in the PITCH
 * actuator. Pressing Start swapped that for the player's own controls, which
 * are centred, and `resetForSpawn` set their trim to zero for an airborne
 * spawn. The elevator therefore fell to nothing -- `actuators.pitch` slews at
 * 7 per second, so it was gone inside five milliseconds -- and the aeroplane
 * departed the trimmed state it had been holding. Measured over 20 s hands-off
 * from a settled menu flight, this is what the player got:
 *
 * | | pitch excursion | peak vertical speed |
 * | --- | ---: | ---: |
 * | trainer | 8.87° | 7.35 m/s |
 * | jet | **21.60°** | **49.70 m/s** |
 * | bizjet | 3.93° | 14.52 m/s |
 *
 * With the seeding: 1.15°/1.30 m/s, 0.07°/0.12 m/s, 0.03°/0.16 m/s.
 *
 * **Units and sign.** The returned value is in `controls.trim` units, the same
 * -1..1 the ArrowUp/ArrowDown keys step by 0.04, and it carries the SAME SIGN
 * as the elevator it replaces: negative is nose-down elevator and a
 * nose-down trim setting. It is not an angle and not a pitch attitude.
 *
 * **Why the factor of two.** `elevator = actuators.pitch + trim *
 * TRIM_ELEVATOR_AUTHORITY`, and that authority is 0.5, so a unit of trim buys
 * half a unit of elevator and carrying an elevator on trim costs twice as much
 * trim. Measured seeds are small -- -0.057, -0.052, -0.014 for the three
 * aeroplanes at cruise -- because the elevator holding a trimmed aeroplane
 * level is itself small.
 *
 * **When trim cannot carry it.** Trim saturates at ±1, so any held elevator
 * beyond ±`TRIM_ELEVATOR_AUTHORITY` (±0.5) is more than trim can hold. The
 * seed clamps, and `handoffPitchRemainder` returns the part that did not fit.
 * That remainder is NOT silently dropped: the caller leaves it in the pitch
 * actuator, where it decays at the actuator's own rate as the aeroplane starts
 * to depart -- which is the old behaviour, but only for the portion trim could
 * not take, and only for an aeroplane that was being held at more than half
 * elevator when the player pressed Start.
 */

/**
 * The elevator actually flying the aeroplane, from the two actuators that
 * compose it. Both are in `FlightVisualState` (`elevator` is the pitch
 * actuator, `trim` the trim actuator), so the main thread can compute this
 * from a snapshot without reaching into the simulation.
 */
export function heldElevator(pitchActuator: number, trimActuator: number): number {
  return pitchActuator + trimActuator * TRIM_ELEVATOR_AUTHORITY;
}

/**
 * The player's trim setting that reproduces `held`, clamped to the trim range.
 */
export function handoffTrimSeed(held: number): number {
  return clamp(held / TRIM_ELEVATOR_AUTHORITY, -1, 1);
}

/**
 * The elevator left over once the seeded trim has taken what it can, which the
 * caller puts back into the pitch actuator so the total is unchanged.
 *
 * Zero whenever trim did not saturate, which is every case measured so far.
 */
export function handoffPitchRemainder(held: number): number {
  return held - handoffTrimSeed(held) * TRIM_ELEVATOR_AUTHORITY;
}
