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
 */
function fitDampingRatio(samples: number[]): number {
  const peaks: number[] = [];
  for (let index = 1; index < samples.length - 1; index += 1) {
    const value = samples[index]!;
    if (Math.abs(value) < 1e-4) continue;
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

function betaPerturbationYawRates(useAugmentation: boolean): number[] {
  const beta = 5 * DEG_TO_RAD;
  const speed = 200;
  const simulator = new FlightSimulator({
    aircraft: FAST_JET,
    spawn: {
      position: { x: 0, y: 2_000, z: 0 },
      heading: Math.PI / 2,
      pitch: 2.4 * DEG_TO_RAD,
      // Same speed, rotated 5 degrees toward the starboard wing: pure
      // sideslip with no initial rates.
      velocity: { x: speed * Math.cos(beta), y: 0, z: -speed * Math.sin(beta) },
      controls: { ...DEFAULT_CONTROLS, throttle: 0.4, gear: 0 },
    },
    controls: { ...DEFAULT_CONTROLS, throttle: 0.4, gear: 0 },
    environment: { wind: { x: 0, y: 0, z: 0 } },
  });
  const augmentation = new JetStabilityAugmentation();
  const requested: FlightControls = {
    ...DEFAULT_CONTROLS,
    throttle: 0.4,
    gear: 0,
  };
  const yawRates: number[] = [];
  for (let step = 0; step < Math.round(10 / FIXED_TIME_STEP); step += 1) {
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
  it("damps a sideslip perturbation to at least the fix-pack dutch-roll floor", () => {
    const augmented = fitDampingRatio(betaPerturbationYawRates(true));
    const unaugmented = fitDampingRatio(betaPerturbationYawRates(false));

    // Closed loop must clear zeta 0.35; the same flight without the damper
    // must be measurably worse, proving the fit actually sees the SAS.
    expect(augmented).toBeGreaterThanOrEqual(0.35);
    expect(unaugmented).toBeLessThan(augmented - 0.08);
  });

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
    simulator.state.angularVelocity.y = -0.4;
    const neutral: FlightControls = { ...DEFAULT_CONTROLS, throttle: 0.5, gear: 0 };
    const damped = augmentation.apply(
      { ...neutral },
      neutral,
      simulator.state,
      simulator.telemetry(),
    );
    expect(damped.yaw).toBeGreaterThan(0.01);
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
