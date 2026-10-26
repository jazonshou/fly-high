import { describe, expect, it } from "vitest";
import {
  BOAT_CALIBRATION,
  BoatSimulator,
  HULL_TRANSOM_CHINE_BEAM,
  KNOT,
  OutboardPowertrain,
  RUNABOUT_21,
  porpoisingTrimLimit,
} from "../src/sim/boat";
import type { StabilityAssistMode } from "../src/sim/assists";
import { NEUTRAL_BOAT_CONTROLS } from "../src/sim/surface";
import { CalmWaterSurface } from "../src/sim/water";
import { HULL_TRANSOM } from "../src/vehicles/boat/hullLines";
import type { BoatControlState } from "../src/game/types";

/**
 * The Runabout 21 under the helm, the trim and the tabs in calm open water:
 * how it turns, how it slides when asked for more than the hull can carve,
 * where it starts to porpoise, what a blown-out propeller does to the
 * engine, and what the tabs do.
 */

const STEP = 1 / 120;
const DEG = Math.PI / 180;

function underWay(assist: StabilityAssistMode, lever: number, knots: number, wind = { x: 0, y: 0, z: 0 }) {
  const boat = new BoatSimulator({ position: { x: 0, y: 0, z: 0 }, heading: 0, moored: false, speed: knots * KNOT, gear: "forward", rpm: 4_400 });
  boat.setEnvironment({ water: new CalmWaterSurface(0, () => -30), wind, bedHeight: () => -30, gravity: 9.80665 });
  const controls: { assist: StabilityAssistMode; boat: BoatControlState } = { assist, boat: { ...NEUTRAL_BOAT_CONTROLS, lever } };
  boat.setControls(controls);
  const telemetry = boat.telemetry();
  const run = (seconds: number, each?: () => void) => {
    for (let i = 0; i < Math.round(seconds / STEP); i += 1) {
      boat.step(STEP);
      boat.telemetry(telemetry);
      each?.();
    }
  };
  const set = (change: Partial<BoatControlState>) => {
    Object.assign(controls.boat, change);
    boat.setControls(controls);
  };
  run(10);
  return { boat, telemetry, run, set };
}

/**
 * Steady-turn figures over a window: mean heel into the turn, worst sideslip,
 * slowest speed, radius from speed over yaw rate, and how far the heel and
 * the yaw rate still swing over the window's last seconds.
 */
function turn(assist: StabilityAssistMode, steer: number, lever: number, knots: number, settle: number, measure: number, tail = 4) {
  const run = underWay(assist, lever, knots);
  run.set({ steer });
  let worstRoll = 0;
  let capsized = false;
  run.run(settle, () => {
    worstRoll = Math.max(worstRoll, Math.abs(run.telemetry.roll));
    capsized ||= run.telemetry.capsized;
  });
  let heel = 0;
  let slip = 0;
  let slowest = Infinity;
  let ground = 0;
  let yaw = 0;
  let n = 0;
  const swing = { rollLow: Infinity, rollHigh: -Infinity, yawLow: Infinity, yawHigh: -Infinity };
  const tailFrom = Math.round((measure - tail) / STEP);
  run.run(measure, () => {
    const t = run.telemetry;
    if (n >= tailFrom) {
      const r = run.boat.state.angularVelocity.y;
      swing.rollLow = Math.min(swing.rollLow, t.roll);
      swing.rollHigh = Math.max(swing.rollHigh, t.roll);
      swing.yawLow = Math.min(swing.yawLow, r);
      swing.yawHigh = Math.max(swing.yawHigh, r);
    }
    worstRoll = Math.max(worstRoll, Math.abs(t.roll));
    capsized ||= t.capsized;
    heel += Math.sign(steer) * t.roll;
    slip = Math.max(slip, Math.abs(t.sideslip));
    slowest = Math.min(slowest, t.speedThroughWater / KNOT);
    const v = run.boat.state.velocity;
    ground += Math.hypot(v.x, v.z);
    yaw += Math.abs(run.boat.state.angularVelocity.y);
    n += 1;
  });
  return {
    heelDegrees: heel / n / DEG,
    slipDegrees: slip / DEG,
    slowestKnots: slowest,
    radius: ground / yaw,
    worstRollDegrees: worstRoll / DEG,
    rollSwingDegrees: (swing.rollHigh - swing.rollLow) / DEG,
    yawSwingDegrees: (swing.yawHigh - swing.yawLow) / DEG,
    capsized,
    crashed: run.telemetry.crashed,
  };
}

describe("boat handling", () => {
  it.each([
    ["starboard", 1],
    ["port", -1],
  ])("heels 10-20 degrees into a hard %s turn at cruise and slides under 20, still on the plane", (_, steer) => {
    // Scenic, full helm from 30 kn: the assist eases the lock at speed and
    // as the hull starts to slide, so this is the hardest turn it carves.
    const hard = turn("scenic", steer as number, 0.75, 28, 4, 11);
    expect(hard.heelDegrees).toBeGreaterThanOrEqual(10);
    expect(hard.heelDegrees).toBeLessThanOrEqual(20);
    expect(hard.slipDegrees).toBeLessThan(20);
    expect(hard.slowestKnots).toBeGreaterThan(16);
    expect(hard.capsized).toBe(false);
  });

  it("turns a steady circle at half helm, and a wider one at a quarter", () => {
    const half = turn("pilot", 0.5, 0.75, 28, 8, 12);
    const quarter = turn("pilot", 0.25, 0.75, 28, 8, 12);
    // About seven boat lengths across at half helm, still at 23 kn.
    expect(half.radius).toBeGreaterThan(35);
    expect(half.radius).toBeLessThan(55);
    expect(half.slowestKnots).toBeGreaterThan(20);
    expect(half.heelDegrees).toBeGreaterThan(5);
    expect(quarter.radius).toBeGreaterThan(1.3 * half.radius);
    expect(quarter.heelDegrees).toBeGreaterThan(0);
  });

  it.each([
    ["starboard", 1],
    ["port", -1],
  ])("settles into a steady carved turn at full wheel to %s at 35 kn, still on the plane", (_, steer) => {
    // Scenic, the game's default, at the planing shots' 35 kn: full wheel
    // and held there. The heel and the yaw rate come to rest instead of
    // swinging, and the hull carves rather than slides.
    const full = turn("scenic", steer as number, 0.83, 35, 6, 8);
    expect(full.rollSwingDegrees).toBeLessThan(1.5);
    expect(full.yawSwingDegrees).toBeLessThan(3);
    expect(full.heelDegrees).toBeGreaterThan(8);
    expect(full.heelDegrees).toBeLessThan(20);
    expect(full.slipDegrees).toBeLessThan(20);
    expect(full.slowestKnots).toBeGreaterThan(20);
    expect(full.capsized).toBe(false);
  });

  it.each(["pilot", "unassisted"] as const)("spins out at full lock at top speed in %s rather than tripping over, then settles", (assist) => {
    for (const steer of [1, -1]) {
      const spin = turn(assist, steer, 1, 38, 2, 13);
      // The leg asks for more yaw than the hull can carve: the heel into the
      // turn puts the bow down, the bottom's lateral load moves forward of
      // the CG and the hull slides (Katayama and Ohashi's spin-out).
      expect(spin.slipDegrees).toBeGreaterThan(20);
      expect(spin.worstRollDegrees).toBeLessThan(60);
      expect(spin.capsized).toBe(false);
      expect(spin.crashed).toBe(false);
      // The slide's roll and yaw swing dies out: it ends a steady sliding turn.
      expect(spin.rollSwingDegrees).toBeLessThan(2);
    }
  });

  /** Running trim and its peak-to-peak swing over 10 s, and Day and Haag's limit at that speed. */
  function trimmedRun(lever: number, trim: -1 | 1) {
    const run = underWay("unassisted", lever, 25);
    run.set({ trim });
    run.run(12);
    run.set({ trim: 0 });
    run.run(8);
    let low = Infinity;
    let high = -Infinity;
    let sum = 0;
    let speed = 0;
    let n = 0;
    run.run(10, () => {
      const t = run.telemetry;
      low = Math.min(low, t.runningTrim);
      high = Math.max(high, t.runningTrim);
      sum += t.runningTrim;
      speed += t.speedThroughWater;
      n += 1;
    });
    speed /= n;
    const halfLift = (RUNABOUT_21.mass * 9.80665) / (1025 * speed * speed * HULL_TRANSOM_CHINE_BEAM ** 2);
    return {
      trimDegrees: sum / n / DEG,
      swingDegrees: (high - low) / DEG,
      limitDegrees: porpoisingTrimLimit(Math.sqrt(halfLift), HULL_TRANSOM.deadriseDegrees),
    };
  }

  it("porpoises trimmed out past Day and Haag's limit, and runs steady just inside it", () => {
    // About 19 kn with the engine trimmed fully out: the bow rides above the limit and the hull bounds.
    const out = trimmedRun(0.58, 1);
    expect(out.trimDegrees).toBeGreaterThan(out.limitDegrees);
    expect(out.swingDegrees).toBeGreaterThan(2);
    // About 22 kn trimmed fully in, on the limit: steady.
    const inside = trimmedRun(0.6, -1);
    expect(inside.trimDegrees).toBeLessThan(inside.limitDegrees + 0.3);
    expect(inside.swingDegrees).toBeLessThan(0.2);
  });

  it("flares to the limiter and loses its thrust when the propeller blows out", () => {
    const run = (immersion: number) => {
      const powertrain = new OutboardPowertrain(RUNABOUT_21, BOAT_CALIBRATION);
      powertrain.reset(5_600, "forward");
      for (let t = 0; t < 3; t += 1 / 240) powertrain.update(1 / 240, 1, 38 * KNOT, immersion, 1025, true, 0.25);
      return powertrain;
    };
    const biting = run(1);
    const blown = run(0.3);
    expect(blown.ventilation).toBeGreaterThan(0.8);
    expect(blown.rpm).toBeGreaterThan(biting.rpm + 200);
    expect(blown.rpm).toBeGreaterThan(RUNABOUT_21.engine.limiterRpm - 150);
    expect(blown.thrust).toBeLessThan(0.5 * biting.thrust);
  });

  it("brings the bow down on its tabs, and Scenic's tabs level a beam wind's heel", () => {
    const run = underWay("pilot", 0.75, 30);
    const before = run.telemetry.runningTrim;
    run.set({ tabs: 1 });
    run.run(6);
    run.set({ tabs: 0 });
    run.run(6);
    expect((before - run.telemetry.runningTrim) / DEG).toBeGreaterThan(1);

    // 15 m/s on the port beam heels the boat a degree to starboard.
    const wind = { x: 15, y: 0, z: 0 };
    const heel = (assist: StabilityAssistMode) => {
      const windy = underWay(assist, 0.75, 30, wind);
      windy.run(20);
      return windy.telemetry.roll;
    };
    const pilot = heel("pilot");
    const scenic = heel("scenic");
    expect(Math.abs(pilot) / DEG).toBeGreaterThan(0.7);
    expect(Math.abs(scenic)).toBeLessThan(0.5 * Math.abs(pilot));
  });
});
