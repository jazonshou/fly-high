import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONTROLS,
  DirectPitchRetention,
  FAST_JET,
  FIXED_TIME_STEP,
  FlightSimulator,
  type FlightControls,
} from "../src/sim";

/** World-up component of body-forward, the exact frame the holder captures. */
function noseVertical(simulator: FlightSimulator): number {
  const { x, y, z, w } = simulator.state.orientation;
  return 2 * (x * y + w * z);
}

interface ReleaseTrace {
  /** Nose-vertical at the release instant. */
  released: number;
  /** Mean nose-vertical over the final second. */
  settled: number;
  /** Highest nose-vertical reached after release. */
  peak: number;
  /** Direction reversals of the post-release trace above the noise floor. */
  reversals: number;
  samples: number[];
}

/**
 * Flies the fix-pack's reported bounce scenario: trimmed flight at 150 m/s,
 * a pitch command held long enough to build real pitch rate, then a release
 * to neutral with `DirectPitchRetention` holding the aircraft afterwards.
 */
function flyPitchRelease(): ReleaseTrace {
  const throttle = 0.15;
  const simulator = new FlightSimulator({
    aircraft: FAST_JET,
    spawn: {
      position: { x: 0, y: 3_000, z: 0 },
      heading: Math.PI / 2,
      pitch: (2.4 * Math.PI) / 180,
      airspeed: 150,
      controls: { ...DEFAULT_CONTROLS, throttle, gear: 0 },
    },
    controls: { ...DEFAULT_CONTROLS, throttle, gear: 0 },
    environment: { wind: { x: 0, y: 0, z: 0 } },
  });
  const retention = new DirectPitchRetention();
  const applyStep = (pitch: number): void => {
    const requested: FlightControls = {
      ...DEFAULT_CONTROLS,
      throttle,
      gear: 0,
      pitch,
    };
    const commanded = retention.apply(
      { ...requested },
      requested,
      simulator.state,
      simulator.telemetry(),
    );
    simulator.step(FIXED_TIME_STEP, commanded);
  };

  // A full-scale pull held for the plan's 1.5 s drives this stabilator-heavy
  // airframe deep past the stall with the nose already falling at release,
  // which hides the bounce entirely. 0.42 s releases just before the stall
  // with +1.26 rad/s of pitch rate in hand - the user-visible tap-and-release
  // case the fix-pack report describes.
  for (let step = 0; step < Math.round(2 / FIXED_TIME_STEP); step += 1) {
    applyStep(0);
  }
  for (let step = 0; step < Math.round(0.42 / FIXED_TIME_STEP); step += 1) {
    applyStep(0.5);
  }

  const released = noseVertical(simulator);
  const samples: number[] = [];
  for (let step = 0; step < Math.round(8 / FIXED_TIME_STEP); step += 1) {
    applyStep(0);
    samples.push(noseVertical(simulator));
  }

  const settleWindow = samples.slice(-Math.round(1 / FIXED_TIME_STEP));
  const settled =
    settleWindow.reduce((sum, value) => sum + value, 0) / settleWindow.length;
  const peak = Math.max(...samples);

  // Count direction reversals with a hysteresis band so integrator-level
  // ripple is not misread as a bounce.
  const noiseFloor = Math.max(0.02 * Math.abs(peak - released), 1e-4);
  let reversals = 0;
  let direction = 0;
  let extreme = samples[0] ?? released;
  for (const value of samples) {
    if (direction >= 0) {
      extreme = Math.max(extreme, value);
      if (extreme - value > noiseFloor) {
        if (direction > 0) reversals += 1;
        direction = -1;
        extreme = value;
      } else if (direction === 0 && value - (samples[0] ?? released) > noiseFloor) {
        direction = 1;
      }
    } else {
      extreme = Math.min(extreme, value);
      if (value - extreme > noiseFloor) {
        reversals += 1;
        direction = 1;
        extreme = value;
      }
    }
  }

  return { released, settled, peak, reversals, samples };
}

describe("pitch release settle behaviour", () => {
  it("settles a released pitch input without bouncing back through the target", () => {
    const trace = flyPitchRelease();
    const totalExcursion = trace.peak - trace.released;
    const overshoot = trace.peak - trace.settled;

    // The nose must genuinely coast forward after release rather than being
    // yanked back to the release-instant attitude.
    expect(totalExcursion).toBeGreaterThan(0.01);
    // The reported bounce: the holder freezes the release-instant attitude,
    // momentum overshoots it, and the holder drags the nose back. The settle
    // target must instead lead the rate so the overshoot beyond the final
    // attitude stays under a quarter of the post-release excursion.
    expect(overshoot).toBeLessThan(0.25 * totalExcursion);
    // One direction change (the settle at the top) is physical; a second one
    // above noise is the bounce.
    expect(trace.reversals).toBeLessThanOrEqual(1);
  });
});
