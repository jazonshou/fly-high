import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONTROLS,
  FAST_JET,
  FIXED_TIME_STEP,
  FlightSimulator,
  JetStabilityAugmentation,
  type FlightControls,
} from "../src/sim";

const DEG_TO_RAD = Math.PI / 180;

/**
 * Damping-ratio fit from successive yaw-rate peak magnitudes (logarithmic
 * decrement over half periods): delta = ln(|p_i| / |p_i+1|),
 * zeta = delta / sqrt(pi^2 + delta^2).
 *
 * Peaks below 5% of the trace's own amplitude are discarded rather than fitted.
 * A well-damped trace falls into the fixed-step integrator's residue within
 * two or three half periods, and ratios taken down there are noise, not decay:
 * including them made the measured zeta at 120 m/s non-monotonic in the damper
 * gain (a k_r that damps the mode harder scored *lower*), which is the signature
 * of fitting noise. With the relative floor the fit is monotonic in gain across
 * the whole sweep.
 */
function fitDampingRatio(samples: number[]): number {
  const amplitude = Math.max(...samples.map((value) => Math.abs(value)));
  const noiseFloor = Math.max(1e-4, amplitude * 0.05);
  const peaks: number[] = [];
  for (let index = 1; index < samples.length - 1; index += 1) {
    const value = samples[index]!;
    if (Math.abs(value) < noiseFloor) continue;
    const previous = samples[index - 1]!;
    const next = samples[index + 1]!;
    if ((value > previous && value >= next) || (value < previous && value <= next)) {
      const lastPeak = peaks[peaks.length - 1];
      if (lastPeak !== undefined && Math.sign(lastPeak) === Math.sign(value)) {
        // The same extremum sampled twice (flat top); keep the larger.
        peaks[peaks.length - 1] =
          Math.abs(value) > Math.abs(lastPeak) ? value : lastPeak;
        continue;
      }
      peaks.push(value);
    }
  }
  // A heavily damped decay may expose only two peaks before the trace falls
  // into the noise floor; one decrement is still a valid fit.
  expect(peaks.length).toBeGreaterThanOrEqual(2);
  const decrements: number[] = [];
  for (let index = 0; index + 1 < Math.min(peaks.length, 5); index += 1) {
    decrements.push(Math.log(Math.abs(peaks[index]!) / Math.abs(peaks[index + 1]!)));
  }
  const delta =
    decrements.reduce((sum, value) => sum + value, 0) / decrements.length;
  return delta / Math.sqrt(Math.PI * Math.PI + delta * delta);
}

/**
 * The J-45's speed band, with enough throttle at each point that the airframe
 * holds roughly the release speed through the 12-second trace instead of
 * decelerating out of the flight condition being measured.
 */
const DUTCH_ROLL_POINTS = [
  { speed: 120, throttle: 0.25, floor: 0.45 },
  { speed: 200, throttle: 0.5, floor: 0.5 },
  { speed: 260, throttle: 0.85, floor: 0.5 },
] as const;

function betaPerturbationYawRates(
  useAugmentation: boolean,
  speed: number,
  throttle: number,
): number[] {
  const beta = 5 * DEG_TO_RAD;
  const simulator = new FlightSimulator({
    aircraft: FAST_JET,
    spawn: {
      position: { x: 0, y: 2_000, z: 0 },
      heading: Math.PI / 2,
      pitch: 2.4 * DEG_TO_RAD,
      // Same speed, rotated 5 degrees toward the starboard wing: pure
      // sideslip with no initial rates.
      velocity: { x: speed * Math.cos(beta), y: 0, z: -speed * Math.sin(beta) },
      controls: { ...DEFAULT_CONTROLS, throttle, gear: 0 },
    },
    controls: { ...DEFAULT_CONTROLS, throttle, gear: 0 },
    environment: { wind: { x: 0, y: 0, z: 0 } },
  });
  const augmentation = new JetStabilityAugmentation();
  const requested: FlightControls = {
    ...DEFAULT_CONTROLS,
    throttle,
    gear: 0,
  };
  const yawRates: number[] = [];
  for (let step = 0; step < Math.round(12 / FIXED_TIME_STEP); step += 1) {
    const commanded = useAugmentation
      ? augmentation.apply(
          { ...requested },
          requested,
          simulator.state,
          simulator.telemetry(),
        )
      : { ...requested };
    simulator.step(FIXED_TIME_STEP, commanded);
    yawRates.push(simulator.state.angularVelocity.y);
  }
  expect(simulator.state.crashed).toBe(false);
  return yawRates;
}

describe("jet stability augmentation", () => {
  it.each(DUTCH_ROLL_POINTS)(
    "damps a sideslip perturbation past the dutch-roll floor at $speed m/s",
    ({ speed, throttle, floor }) => {
      const augmented = fitDampingRatio(
        betaPerturbationYawRates(true, speed, throttle),
      );
      const unaugmented = fitDampingRatio(
        betaPerturbationYawRates(false, speed, throttle),
      );

      // The J-45 airframe alone sits at zeta ~0.163 at every speed (the
      // "drunk" report); the damper must lift it over 0.45 at the worst
      // corner and over 0.5 across the cruise band, and the unaugmented run
      // must be measurably worse so the fit is provably seeing the SAS.
      expect(augmented).toBeGreaterThanOrEqual(floor);
      expect(unaugmented).toBeLessThan(0.25);
      expect(unaugmented).toBeLessThan(augmented - 0.2);
    },
  );

  it("washes out the rudder in a held banked turn instead of fighting it", () => {
    const simulator = new FlightSimulator({
      aircraft: FAST_JET,
      spawn: {
        position: { x: 0, y: 2_000, z: 0 },
        heading: 0,
        pitch: 2.4 * DEG_TO_RAD,
        bank: 40 * DEG_TO_RAD,
        airspeed: 170,
        controls: { ...DEFAULT_CONTROLS, throttle: 0.55, gear: 0 },
      },
      controls: { ...DEFAULT_CONTROLS, throttle: 0.55, gear: 0 },
      environment: { wind: { x: 0, y: 0, z: 0 } },
    });
    const augmentation = new JetStabilityAugmentation();
    let peakRudder = 0;
    let rudderAtFourSeconds = 0;

    for (let step = 0; step < Math.round(6 / FIXED_TIME_STEP); step += 1) {
      const telemetry = simulator.telemetry();
      // The pilot holds the 40-degree bank with an active roll command.
      const requested: FlightControls = {
        ...DEFAULT_CONTROLS,
        throttle: 0.55,
        gear: 0,
        roll: Math.min(
          0.5,
          Math.max(
            -0.5,
            (40 * DEG_TO_RAD - telemetry.bank) * 1.2 +
              simulator.state.angularVelocity.x * 0.35,
          ),
        ),
        pitch: 0.06,
      };
      const commanded = augmentation.apply(
        { ...requested },
        requested,
        simulator.state,
        telemetry,
      );
      simulator.step(FIXED_TIME_STEP, commanded);
      const contribution = Math.abs(augmentation.rudderContribution);
      if (simulator.state.time < 2) peakRudder = Math.max(peakRudder, contribution);
      if (simulator.state.time <= 4) rudderAtFourSeconds = contribution;
    }

    const finalBank = (simulator.telemetry().bank * 180) / Math.PI;
    expect(simulator.state.crashed).toBe(false);
    // The turn is genuinely established and held.
    expect(finalBank).toBeGreaterThan(28);
    expect(finalBank).toBeLessThan(52);
    // The steady coordinated-turn yaw rate washes out: by 4 s the damper has
    // released the rudder rather than holding a standing anti-turn command.
    expect(rudderAtFourSeconds).toBeLessThan(0.03);
    expect(rudderAtFourSeconds).toBeLessThanOrEqual(Math.max(0.005, peakRudder * 0.5));
  });

  it("never modifies an axis the pilot is actively commanding", () => {
    const simulator = new FlightSimulator({
      aircraft: FAST_JET,
      spawn: {
        position: { x: 0, y: 2_000, z: 0 },
        airspeed: 170,
        angularVelocity: { x: 0.6, y: 0.5, z: 0 },
        controls: { ...DEFAULT_CONTROLS, throttle: 0.5, gear: 0 },
      },
      controls: { ...DEFAULT_CONTROLS, throttle: 0.5, gear: 0 },
    });
    const augmentation = new JetStabilityAugmentation();
    const requested: FlightControls = {
      ...DEFAULT_CONTROLS,
      throttle: 0.5,
      gear: 0,
      yaw: 0.041,
      roll: -0.041,
    };

    const commanded = augmentation.apply(
      { ...requested },
      requested,
      simulator.state,
      simulator.telemetry(),
    );
    // Both axes sit just above the 0.04 doctrine threshold: byte-for-byte
    // pass-through despite the large body rates.
    expect(commanded.yaw).toBe(0.041);
    expect(commanded.roll).toBe(-0.041);

    // The washout primed on the first call; a subsequent yaw-rate change is
    // exactly what the damper must oppose once the axes go neutral.
    //
    // D-6 sign note: this block feeds RAW omega_y, and with +Z = starboard a
    // swing from omega_y +0.5 to -0.4 is a swing toward NOSE-RIGHT in pilot
    // terms (nose-right is -omega_y), so the damper now answers with LEFT
    // rudder. The pre-D-6 assertion expected +yaw for the same raw numbers
    // because the old basis read them as a nose-left swing -- the damper's
    // physical law (oppose the washed pilot-sign rate) is unchanged.
    simulator.state.angularVelocity.y = -0.4;
    const neutral: FlightControls = { ...DEFAULT_CONTROLS, throttle: 0.5, gear: 0 };
    const damped = augmentation.apply(
      { ...neutral },
      neutral,
      simulator.state,
      simulator.telemetry(),
    );
    expect(damped.yaw).toBeLessThan(-0.01);
    expect(damped.roll).not.toBe(neutral.roll);
  });

  it("stays disengaged on the ground and below control airspeed, and resets", () => {
    const grounded = new FlightSimulator({
      aircraft: FAST_JET,
      spawn: { onGround: true, terrainHeight: 0 },
      environment: {
        terrain: { height: 0, normal: { x: 0, y: 1, z: 0 }, friction: 1.15 },
      },
    });
    grounded.state.angularVelocity.y = 0.8;
    const augmentation = new JetStabilityAugmentation();
    const neutral: FlightControls = { ...DEFAULT_CONTROLS, throttle: 0.2 };

    const onGround = augmentation.apply(
      { ...neutral },
      neutral,
      grounded.state,
      grounded.telemetry(),
    );
    expect(onGround).toEqual(neutral);
    expect(augmentation.rudderContribution).toBe(0);

    const slow = new FlightSimulator({
      aircraft: FAST_JET,
      spawn: {
        position: { x: 0, y: 2_000, z: 0 },
        airspeed: 20,
        angularVelocity: { x: 0, y: 0.5, z: 0 },
        controls: { ...DEFAULT_CONTROLS, throttle: 0.5, gear: 0 },
      },
    });
    const slowResult = augmentation.apply(
      { ...neutral },
      neutral,
      slow.state,
      slow.telemetry(),
    );
    expect(slowResult).toEqual(neutral);

    augmentation.reset();
    expect(augmentation.rudderContribution).toBe(0);
    expect(augmentation.aileronContribution).toBe(0);
  });

  it("is applied by the worker only for the jet in unassisted mode", () => {
    const source = readFileSync(
      new URL("../src/workers/simulation.worker.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain("new JetStabilityAugmentation()");
    expect(source).toContain('if (selectedMode !== "unassisted") return selectedControls;');
    expect(source).toContain('aircraftKind === "jet"');
    // Every spawn resets the filters, exactly like DirectPitchRetention.
    expect(source.match(/jetStabilityAugmentation\.reset\(\)/g)?.length).toBeGreaterThanOrEqual(4);
  });
});
