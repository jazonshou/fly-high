import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AIRCRAFT_KINDS,
  AttractHold,
  DEFAULT_CONTROLS,
  DirectPitchRetention,
  FIXED_TIME_STEP,
  FlightSimulator,
  TRIM_ELEVATOR_AUTHORITY,
  aircraftDefinition,
  applyFlightAssistance,
  handoffPitchRemainder,
  handoffTrimSeed,
  heldElevator,
  stallSpeed,
  type AircraftKind,
  type AttractHoldOutput,
  type EnvironmentInput,
  type FlightControls,
  type StabilityAssistMode,
} from "../src/sim";
import { airborneAirspeedForAircraft, airborneThrottleForAircraft } from "../src/game/spawn";

/**
 * Pressing Start hands the player an aeroplane that is already trimmed.
 *
 * Jason: *"Sure let's do that"*. Before this, `resetForSpawn` set an airborne
 * spawn's trim to zero and the menu flight's elevator — which lives in the
 * PITCH actuator, because the attract supervisor flies by writing
 * `controls.pitch` — simply vanished. `actuators.pitch` slews at 7 per second,
 * so it was gone in five milliseconds and the aeroplane departed the trimmed
 * state it had been holding.
 *
 * Everything here is kind-agnostic over `AIRCRAFT_KINDS`, and every flight
 * test runs BOTH arms so the unseeded one is a positive control in the same
 * output: it states what these numbers read when the defect IS present. A pass
 * from the seeded arm alone would not distinguish a fix from a test that never
 * exercised the hand-off.
 */

const GROUND = 0;
const environment: EnvironmentInput = {
  terrain: () => ({ height: GROUND, friction: 0.86 }),
  terrainHeight: () => GROUND,
  seaLevel: GROUND,
};

/**
 * The scenario, and why it is not simply "cruise".
 *
 * The test's EXPOSURE is the elevator the menu flight is holding when the
 * player presses Start, because that is exactly what the unseeded hand-off
 * loses. An aeroplane sitting at its own zero-elevator trim point holds
 * nothing, so for that kind "seeded" and "unseeded" are the SAME EXPERIMENT
 * and every comparison between them is void — not passed, not failed.
 *
 * That is not hypothetical. At catalogue cruise the held elevator is incidental:
 * it was −0.0286/−0.0258/−0.0069 on the trainer/jet/bizjet when this test was
 * written, but on the aircraft branch, which lifts a silent 180 m/s spawn clamp
 * so the Global spawns at its catalogue speed and near trim, it is
 * −0.0254/−0.0015/−0.0005 and −0.0001 for the 747-8. Three of four kinds had
 * nothing to lose and the control went vacuous.
 *
 * So the exposure is created deliberately: the menu flight settles LEVEL at a
 * fifth above catalogue cruise, which is faster than the zero-elevator trim
 * speed and therefore needs a real nose-down elevator to hold. Faster rather
 * than slower on purpose — flying BELOW the trim speed also creates exposure,
 * but it drives the throttle to idle, and an aeroplane handed over at idle
 * departs over the next twenty seconds whatever the elevator does, which
 * measures the scenario instead of the hand-off. Above the trim point the power
 * to sustain it is within the engine's range.
 */
const CRUISE_MULTIPLE = 1.2;
/**
 * Exposure below which the comparison is void. A run under this floor means the
 * SCENARIO has stopped creating exposure — a new airframe, a changed catalogue,
 * a changed spawn — and fails loudly, because a test that cannot tell the fix
 * from its absence must say so rather than pass.
 */
const EXPOSURE_FLOOR = 0.01;
/** The unseeded arm must lose essentially all of it; the seeded arm must keep it. */
const UNSEEDED_LOSS_FRACTION = 0.7;
const SEEDED_KEPT_FRACTION = 0.1;
const ELEVATOR_STEP_LIMIT = 0.005;
/**
 * How much of the unseeded arm's departure the seeding must remove.
 *
 * A RATIO, not an absolute angle, because the excursion is a property of the
 * airframe's own response and not of the mechanism: the 747-8 barely moves when
 * it loses a small elevator and the jet leaves violently. Measured ratios are
 * 7-11% and under, so a third is far from every one of them.
 */
const EXCURSION_SHARE = 1 / 3;

interface HandoffResult {
  readonly seededTrim: number;
  readonly heldAtHandoff: number;
  /** Largest |elevator - held| more than a second after the hand-off. */
  readonly settledDrift: number;
  /** |elevator - held| on the first frame the player owns the aeroplane. */
  readonly stepAtHandoff: number;
  readonly pitchExcursion: number;
  readonly worstVerticalSpeed: number;
  readonly handoverThrottle: number;
}

/**
 * Flies the menu demo until it has actually settled, hands over, and flies the
 * next twenty seconds hands-off exactly as the worker does.
 *
 * It waits for the CONDITION rather than a fixed number of seconds: attract
 * holds `max(targetClearance, groundSpeed * 6)`, so a fast aeroplane is still
 * climbing after two minutes, and a clock-timed hand-off would measure the
 * middle of a climb.
 */
function handOver(
  kind: AircraftKind,
  mode: StabilityAssistMode,
  seed: boolean,
): HandoffResult {
  const aircraft = aircraftDefinition(kind);
  const spawnThrottle = airborneThrottleForAircraft(kind);
  const simulator = new FlightSimulator({
    aircraft,
    spawn: { position: { x: 0, y: 1_200, z: 0 }, airspeed: airborneAirspeedForAircraft(kind) },
    controls: { throttle: spawnThrottle },
    environment,
  });
  const attract = new AttractHold(spawnThrottle);
  const supervisor: AttractHoldOutput = { pitch: 0, roll: 0, throttle: spawnThrottle };
  const requested: FlightControls = { ...DEFAULT_CONTROLS, throttle: spawnThrottle };
  const assisted: FlightControls = { ...DEFAULT_CONTROLS };
  const elevator = () =>
    heldElevator(simulator.state.actuators.pitch, simulator.state.actuators.trim);

  let settledSeconds = 0;
  const patience = Math.round(600 / FIXED_TIME_STEP);
  for (let step = 0; step < patience && settledSeconds < 5; step += 1) {
    const telemetry = simulator.telemetry();
    attract.update(
      {
        clearance: telemetry.altitudeAgl,
        targetClearance: 1_200 - GROUND,
        requiredClimbRate: 0,
        requiredClimbRateLeft: 0,
        requiredClimbRateRight: 0,
        verticalSpeed: telemetry.verticalSpeed,
        groundSpeed: telemetry.groundSpeed,
        equivalentAirspeed: telemetry.indicatedAirspeed,
        targetAirspeed: airborneAirspeedForAircraft(kind) * CRUISE_MULTIPLE,
        stallSpeed: stallSpeed(aircraft, simulator.state.actuators.flaps),
        dt: FIXED_TIME_STEP,
      },
      supervisor,
    );
    requested.pitch = supervisor.pitch;
    requested.roll = supervisor.roll;
    requested.throttle = supervisor.throttle;
    simulator.setControls(
      applyFlightAssistance(assisted, "scenic", requested, simulator.state, telemetry),
    );
    simulator.step(FIXED_TIME_STEP);
    settledSeconds = Math.abs(simulator.telemetry().verticalSpeed) < 0.2
      ? settledSeconds + FIXED_TIME_STEP
      : 0;
  }
  // A hand-off measured out of a climb says nothing about the hand-off, so an
  // unsettled run is void rather than clean.
  expect(settledSeconds, `${kind}: the menu flight settled before the hand-off`)
    .toBeGreaterThanOrEqual(5);

  const heldAtHandoff = elevator();
  const pitchAtHandoff = (simulator.telemetry().pitch * 180) / Math.PI;

  // The hand-off, as the worker performs it.
  const seededTrim = seed ? handoffTrimSeed(heldAtHandoff) : 0;
  if (seed) {
    simulator.state.actuators.trim = seededTrim;
    simulator.state.actuators.pitch = handoffPitchRemainder(heldAtHandoff);
  }

  // The player's own flight. Throttle is seeded from the live state because
  // `takeControl` already does that (`inputRef.setThrottle(latestState.throttle)`);
  // handing them the SPAWN throttle instead steps the thrust and drives a
  // phugoid that has nothing to do with the elevator.
  const retention = new DirectPitchRetention();
  const pilot: FlightControls = {
    ...DEFAULT_CONTROLS,
    throttle: simulator.state.actuators.throttle,
    trim: seededTrim,
  };
  let settledDrift = 0;
  let stepAtHandoff = 0;
  let minPitch = Infinity;
  let maxPitch = -Infinity;
  let worstVerticalSpeed = 0;
  for (let step = 0; step < Math.round(20 / FIXED_TIME_STEP); step += 1) {
    const telemetry = simulator.telemetry();
    const selected = applyFlightAssistance(assisted, mode, pilot, simulator.state, telemetry);
    simulator.setControls(
      mode === "unassisted"
        ? retention.apply(selected, pilot, simulator.state, telemetry)
        : selected,
    );
    simulator.step(FIXED_TIME_STEP);
    const drift = Math.abs(elevator() - heldAtHandoff);
    if (step === 0) stepAtHandoff = drift;
    // More than a second out, so a tenth of a second of actuator slew is not
    // confused with an elevator that never comes back.
    if (step * FIXED_TIME_STEP > 1) settledDrift = Math.max(settledDrift, drift);
    const after = simulator.telemetry();
    const degrees = (after.pitch * 180) / Math.PI;
    minPitch = Math.min(minPitch, degrees);
    maxPitch = Math.max(maxPitch, degrees);
    worstVerticalSpeed = Math.max(worstVerticalSpeed, Math.abs(after.verticalSpeed));
  }
  return {
    seededTrim,
    handoverThrottle: simulator.state.actuators.throttle,
    heldAtHandoff,
    settledDrift,
    stepAtHandoff,
    pitchExcursion: Math.max(maxPitch - pitchAtHandoff, pitchAtHandoff - minPitch),
    worstVerticalSpeed,
  };
}

describe.each(["unassisted", "pilot"] as const)(
  "the menu-to-flight hand-off in %s mode",
  (mode) => {
    describe.each(AIRCRAFT_KINDS)("the %s", (kind) => {
      it("keeps flying what it was flying, and the unseeded arm proves the test bites", () => {
        const seeded = handOver(kind, mode, true);
        const unseeded = handOver(kind, mode, false);
        const exposure = Math.abs(unseeded.heldAtHandoff);

        // Everything this test claims is relative to the exposure, so the
        // exposure goes in every message. A reader who sees a conclusion here
        // can see what it was measured against without running anything.
        const report =
          `${kind}/${mode}: exposure ${exposure.toFixed(5)} of elevator held at ` +
          `the hand-off (throttle ${unseeded.handoverThrottle.toFixed(2)}); unseeded arm ` +
          `lost ${unseeded.settledDrift.toFixed(5)} and departed ` +
          `${unseeded.pitchExcursion.toFixed(2)} deg / ` +
          `${unseeded.worstVerticalSpeed.toFixed(2)} m/s; seeded arm ` +
          `lost ${seeded.settledDrift.toFixed(5)} and departed ` +
          `${seeded.pitchExcursion.toFixed(2)} deg / ` +
          `${seeded.worstVerticalSpeed.toFixed(2)} m/s`;

        // THE EXPOSURE GATE. Below the floor the two arms are the same
        // experiment and nothing below this line means anything, so the run is
        // VOID -- which is a failure of the scenario, reported as one, rather
        // than a quiet pass.
        expect(
          exposure,
          `VOID, not passed: this scenario no longer creates exposure. ${report}. ` +
          `Flying at ${CRUISE_MULTIPLE}x catalogue cruise is supposed to sit off ` +
          "the zero-elevator trim point; if this aeroplane trims out there, the " +
          "scenario needs changing, not the bound",
        ).toBeGreaterThan(EXPOSURE_FLOOR);

        // THE MECHANISM, stated on the quantity it acts on. The unseeded arm
        // loses the elevator it was holding; the seeded arm keeps it. This is
        // arithmetic about the elevator, so it bites for ANY real exposure
        // however placid the airframe's response to losing it.
        expect(
          unseeded.settledDrift,
          `POSITIVE CONTROL FAILED -- with the seeding off the elevator survived, ` +
          `so this test cannot tell the fix from its absence. ${report}`,
        ).toBeGreaterThan(UNSEEDED_LOSS_FRACTION * exposure);
        expect(seeded.settledDrift, report)
          .toBeLessThan(Math.max(SEEDED_KEPT_FRACTION * exposure, ELEVATOR_STEP_LIMIT));

        // AND THE CONSEQUENCE, as a share of what the unfixed hand-off did
        // rather than an absolute angle -- see EXCURSION_SHARE.
        expect(seeded.pitchExcursion, report)
          .toBeLessThan(EXCURSION_SHARE * unseeded.pitchExcursion);
        expect(seeded.worstVerticalSpeed, report)
          .toBeLessThan(EXCURSION_SHARE * unseeded.worstVerticalSpeed);

        // The seed is a trim SETTING, not an angle: same sign as the elevator
        // it replaces, twice its size because trim authority is half.
        expect(Math.sign(seeded.seededTrim)).toBe(Math.sign(seeded.heldAtHandoff));
        expect(Math.abs(seeded.seededTrim)).toBeGreaterThan(Math.abs(seeded.heldAtHandoff));
      });
    });
  },
);

describe("the seed's units, sign and saturation", () => {
  it("is in controls.trim units and keeps the elevator's sign", () => {
    // A unit of trim buys TRIM_ELEVATOR_AUTHORITY of elevator, so carrying an
    // elevator on trim costs 1/authority times as much trim.
    expect(handoffTrimSeed(0.1)).toBeCloseTo(0.1 / TRIM_ELEVATOR_AUTHORITY, 12);
    expect(handoffTrimSeed(-0.1)).toBeCloseTo(-0.1 / TRIM_ELEVATOR_AUTHORITY, 12);
    expect(handoffTrimSeed(0)).toBe(0);
  });

  it("reads the elevator from the two actuators that compose it", () => {
    expect(heldElevator(0.3, 0.4)).toBeCloseTo(0.3 + 0.4 * TRIM_ELEVATOR_AUTHORITY, 12);
    // Which is exactly what the simulation flies, so the seed cannot be
    // computed against a different number than the physics uses.
    expect(heldElevator(0.2, 0)).toBe(0.2);
  });

  it("leaves the part trim cannot carry in the pitch actuator, rather than dropping it", () => {
    // Trim saturates at +/-1, so it can hold at most TRIM_ELEVATOR_AUTHORITY
    // of elevator. Anything beyond that is the pitch actuator's, and the total
    // must still be the elevator that was flying the aeroplane.
    const beyondTrim = TRIM_ELEVATOR_AUTHORITY + 0.2;
    expect(handoffTrimSeed(beyondTrim)).toBe(1);
    expect(handoffPitchRemainder(beyondTrim)).toBeCloseTo(0.2, 12);
    expect(
      handoffPitchRemainder(beyondTrim) + handoffTrimSeed(beyondTrim) * TRIM_ELEVATOR_AUTHORITY,
      "the transfer conserves the elevator",
    ).toBeCloseTo(beyondTrim, 12);

    // Within trim's reach there is nothing left over, which is every case
    // measured so far: the seeds at cruise are -0.057, -0.052 and -0.014.
    expect(handoffPitchRemainder(-0.0286)).toBeCloseTo(0, 12);
    expect(handoffPitchRemainder(0.4)).toBeCloseTo(0, 12);
  });

  it("conserves the elevator for any held value, saturated or not", () => {
    for (const held of [-1.4, -0.9, -0.5, -0.03, 0, 0.03, 0.5, 0.9, 1.4]) {
      const carried = handoffTrimSeed(held) * TRIM_ELEVATOR_AUTHORITY +
        handoffPitchRemainder(held);
      expect(carried, `held ${held}`).toBeCloseTo(held, 12);
    }
  });
});

describe("the seed and DirectPitchRetention", () => {
  const aircraft = aircraftDefinition(AIRCRAFT_KINDS[0]);

  function airborneState(seededTrim: number) {
    const simulator = new FlightSimulator({
      aircraft,
      spawn: {
        position: { x: 0, y: 1_200, z: 0 },
        airspeed: airborneAirspeedForAircraft(AIRCRAFT_KINDS[0]),
      },
      controls: { throttle: 0.7 },
      environment,
    });
    simulator.state.actuators.trim = seededTrim;
    return simulator;
  }

  it("does not read the seed as a trim the pilot just made", () => {
    // Retention turns a CHANGE in requested trim into a change of its held
    // attitude. The seed arrives as a non-zero trim on the first frame after
    // the hand-off, and must not be mistaken for the pilot winding the wheel:
    // `lastRequestedTrim` is null after a reset, so the first frame's delta is
    // measured against itself and is zero.
    const retention = new DirectPitchRetention();
    const simulator = airborneState(-0.0517);
    const pilot: FlightControls = { ...DEFAULT_CONTROLS, throttle: 0.7, trim: -0.0517 };
    const assisted: FlightControls = { ...DEFAULT_CONTROLS };
    const telemetry = simulator.telemetry();
    const selected = applyFlightAssistance(assisted, "unassisted", pilot, simulator.state, telemetry);
    const retained = retention.apply(selected, pilot, simulator.state, telemetry);
    // Neutral input before the pilot has chosen an attitude is raw flight, so
    // the seed passes through untouched rather than being held or reshaped.
    expect(retained.pitch).toBe(selected.pitch);
    expect(retained.trim).toBe(-0.0517);
  });

  it("still lets the player re-trim from the seeded value", () => {
    // "The player can re-trim as usual" is a DIFFERENCE, so measure it as one:
    // the same flight twice, once with a keyboard trim step from the seeded
    // value and once without. Comparing one flight's pitch before and after
    // its own trim step instead measures whatever the aeroplane was doing
    // anyway -- the first version of this test pulled hard enough to zoom the
    // trainer to 44 degrees and stall it, and read the stall break as the
    // trim's effect.
    const SEED = -0.0517;
    const flyWith = (trimStep: number) => {
      const retention = new DirectPitchRetention();
      const simulator = airborneState(SEED);
      const assisted: FlightControls = { ...DEFAULT_CONTROLS };
      const pilot: FlightControls = { ...DEFAULT_CONTROLS, throttle: 0.7, trim: SEED };
      const run = (seconds: number) => {
        for (let step = 0; step < Math.round(seconds / FIXED_TIME_STEP); step += 1) {
          const telemetry = simulator.telemetry();
          const selected = applyFlightAssistance(
            assisted, "unassisted", pilot, simulator.state, telemetry,
          );
          simulator.setControls(retention.apply(selected, pilot, simulator.state, telemetry));
          simulator.step(FIXED_TIME_STEP);
        }
      };
      // A gentle command and release, so retention has an attitude to hold and
      // the aeroplane stays in ordinary flight.
      pilot.pitch = 0.12;
      run(1);
      pilot.pitch = 0;
      run(3);
      // One keyboard step of nose-up trim, from the SEEDED value.
      pilot.trim = SEED + trimStep;
      run(6);
      return (simulator.telemetry().pitch * 180) / Math.PI;
    };

    const untrimmed = flyWith(0);
    const trimmedUp = flyWith(0.04);
    expect(trimmedUp, "a keyboard trim step from the seeded value raises the nose")
      .toBeGreaterThan(untrimmed);
    // And it is a trim step, not a lurch: one 0.04 press is about a degree.
    expect(trimmedUp - untrimmed).toBeLessThan(5);
  });
});

describe("the seed reaches the aeroplane through the thing that owns trim", () => {
  // The input controller HOLDS trim, steps it on ArrowUp/ArrowDown, and
  // re-sends it with every control message. So a trim written anywhere else is
  // undone by its next message, and these assertions exist to make somebody
  // look when the call sites move. The worker cannot be imported (it
  // dereferences `self` at module scope and starts a timer on load), so this
  // reads the sources as text, as tests/sim.attract-hold.test.ts does.
  const read = (path: string) =>
    readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

  it("seeds the input controller, and does it before the hand-off is sent", () => {
    const source = read("src/game/FlightGame.tsx");
    expect(source).toContain("inputRef.current?.setTrim(handoffTrim)");
    expect(source).toContain("simulationRef.current?.handoff(settingsRef.current.flightMode, handoffTrim)");
    // Order is load-bearing three times over: `resetForSpawn` zeroes an
    // airborne spawn's trim, so seeding must come after it; the worker's copy
    // must not be sent before the controller holds the same value; and the
    // controller's next message has to carry the seed rather than a stale zero.
    const reset = source.indexOf("inputRef.current?.resetForSpawn(");
    const seed = source.indexOf("inputRef.current?.setTrim(");
    const handoff = source.indexOf("simulationRef.current?.handoff(");
    expect(reset).toBeGreaterThan(-1);
    expect(seed, "seeded after resetForSpawn").toBeGreaterThan(reset);
    expect(handoff, "seeded before the hand-off is sent").toBeGreaterThan(seed);
  });

  it("does not seed trim in Scenic, which carries it a different way", () => {
    // Scenic's own height hold adopts the menu flight's learned trim, so
    // seeding controls.trim as well would be two mechanisms carrying one
    // elevator and the aeroplane would get twice what it needs.
    const source = read("src/game/FlightGame.tsx");
    expect(source).toContain('settingsRef.current.flightMode === "scenic"');
    const worker = read("src/workers/simulation.worker.ts");
    expect(worker).toContain('} else if (command.mode !== "scenic" && simulator) {');
    expect(worker.match(/actuators\.trim = seeded/g)).toHaveLength(1);
  });

  it("leaves runway starts and restarts exactly as they were", () => {
    // Only the menu-to-flight hand-off seeds. A runway start and a restart go
    // through resetForSpawn and the worker's own reset, neither of which this
    // change touches.
    const input = read("src/input/index.ts");
    expect(input).toContain('this.trim = spawn === "runway" ? runwayTrim : 0;');
    const game = read("src/game/FlightGame.tsx");
    // `setTrim` is called from the hand-off and nowhere else.
    expect(game.match(/setTrim\(/g)).toHaveLength(1);
  });
});
