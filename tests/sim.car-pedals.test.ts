import { describe, expect, it } from "vitest";
import type { GroundVehicleSimulator } from "../src/sim/ground";
import { STOPPED_SPEED } from "../src/sim/ground/transmission";
import { car, drive, speedOf, STEP } from "./support/carRig";

/**
 * The car's pedals with no gears to choose (Jason, 2026-11-05): W drives
 * forward, S backward, Space brakes. Going forward S is the brake, and held
 * through the stop it backs the car up; reversing, W does the same the
 * other way. Space brakes either way and never changes direction. The
 * automatic picks its six gears by itself.
 */

/** Hold `input` until the car reaches `speed` m/s (signed), at most `limit` s. */
function reach(sim: GroundVehicleSimulator, input: Parameters<typeof drive>[2], speed: number, limit = 30): void {
  let time = 0;
  const done = () => (speed >= 0 ? speedOf(sim) >= speed : speedOf(sim) <= speed);
  while (!done() && time < limit) {
    drive(sim, STEP, input);
    time += STEP;
  }
  if (!done()) throw new Error(`${speed} m/s not reached in ${limit} s`);
}

/** Hold `input` for `seconds`: when the car first stops, and when its selector first reads `selector`. */
function holdThroughStop(
  sim: GroundVehicleSimulator,
  input: Parameters<typeof drive>[2],
  seconds: number,
  selector: "D" | "R",
): { stoppedAt: number; changedAt: number } {
  let time = 0;
  let stoppedAt = -1;
  let changedAt = -1;
  drive(sim, seconds, input, (s) => {
    time += STEP;
    if (stoppedAt < 0 && Math.abs(speedOf(s)) < STOPPED_SPEED) stoppedAt = time;
    if (changedAt < 0 && s.transmission.selector === selector) changedAt = time;
  });
  return { stoppedAt, changedAt };
}

describe("the car's pedals", () => {
  it("drives forward on W and backs up on S from a standing start", () => {
    const ahead = car();
    drive(ahead, 0.5, {});
    expect(ahead.transmission.selector).toBe("P");
    drive(ahead, 3, { accelerator: 0.5 });
    expect(ahead.transmission.selector).toBe("D");
    expect(speedOf(ahead)).toBeGreaterThan(2);

    const back = car();
    drive(back, 0.5, {});
    drive(back, 3, { reverse: 0.5 });
    expect(back.transmission.selector).toBe("R");
    expect(speedOf(back)).toBeLessThan(-1);
    expect(back.visualState().reversing).toBe(true);
  });

  it("brakes on a held S and, still held, backs the car up a moment after it stops", () => {
    const sim = car();
    drive(sim, 0.5, {});
    reach(sim, { accelerator: 1 }, 12);
    const { stoppedAt, changedAt } = holdThroughStop(sim, { reverse: 1 }, 8, "R");
    expect(stoppedAt).toBeGreaterThan(0);
    // Braked all the way down in D, then a short pause at the stop, then R.
    expect(changedAt - stoppedAt).toBeGreaterThan(0.2);
    expect(changedAt - stoppedAt).toBeLessThan(0.6);
    expect(sim.transmission.selector).toBe("R");
    expect(speedOf(sim)).toBeLessThan(-2);
  });

  it("brakes on a held W while reversing and, still held, drives forward once stopped", () => {
    const sim = car();
    drive(sim, 0.5, {});
    reach(sim, { reverse: 1 }, -4);
    const { stoppedAt, changedAt } = holdThroughStop(sim, { accelerator: 1 }, 6, "D");
    expect(stoppedAt).toBeGreaterThan(0);
    expect(changedAt - stoppedAt).toBeGreaterThan(0.2);
    expect(changedAt - stoppedAt).toBeLessThan(0.6);
    expect(speedOf(sim)).toBeGreaterThan(2);
  });

  it("brakes on Space either way and holds the car at the stop without changing direction", () => {
    const sim = car();
    drive(sim, 0.5, {});
    reach(sim, { accelerator: 1 }, 15);
    let lit = false;
    drive(sim, 6, { brake: 1 }, (s) => {
      lit ||= s.visualState().brakeLights;
    });
    expect(lit).toBe(true);
    expect(Math.abs(speedOf(sim))).toBeLessThan(0.05);
    expect(sim.transmission.selector).toBe("D");
    // Held on Space for a while longer, it stays stopped and in D.
    drive(sim, 3, { brake: 1 });
    expect(Math.abs(speedOf(sim))).toBeLessThan(0.05);
    expect(sim.transmission.selector).toBe("D");

    // Backing up, Space stops it the same way and it stays in R.
    drive(sim, 1, { reverse: 1 });
    reach(sim, { reverse: 1 }, -3);
    drive(sim, 4, { brake: 1 });
    expect(Math.abs(speedOf(sim))).toBeLessThan(0.05);
    expect(sim.transmission.selector).toBe("R");
  });

  it("changes nothing at a stop while W and S are both held", () => {
    const sim = car();
    drive(sim, 0.5, {});
    drive(sim, 0.5, { accelerator: 0.3 });
    drive(sim, 4, { brake: 1 });
    expect(sim.transmission.selector).toBe("D");
    drive(sim, 2, { accelerator: 0.3, reverse: 1 });
    expect(sim.transmission.selector).toBe("D");
  });

  it("picks its gears by itself: up through the box on W, back to first at the stop", () => {
    const sim = car();
    drive(sim, 0.5, {});
    let top = 0;
    reach(sim, { accelerator: 1 }, 30, 40);
    drive(sim, 2, { accelerator: 1 }, (s) => {
      top = Math.max(top, s.transmission.gear);
    });
    expect(top).toBeGreaterThanOrEqual(4);
    expect(sim.transmission.selector).toBe("D");
    drive(sim, 10, { brake: 1 });
    expect(sim.transmission.gear).toBe(1);
  });
});
