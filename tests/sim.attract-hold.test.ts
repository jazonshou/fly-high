import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ATTRACT_MIN_CLEARANCE_SECONDS,
  ATTRACT_RESEED_CLEARANCE_METERS,
  ATTRACT_SCAN_MAX_METERS,
  ATTRACT_SCAN_SECONDS,
  ATTRACT_TURN_RATE_RADIANS_PER_SECOND,
  AttractHold,
  attractAchievableClimbRate,
  attractClimbRateFor,
  attractScanDistance,
  attractScanOffset,
  attractScanSamples,
  attractTrackVector,
  attractTurnRoll,
  shouldReseedAttract,
  type AttractHoldInput,
  FlightSimulator,
  aircraftDefinition,
} from "../src/sim";

/**
 * The menu flight's altitude hold.
 *
 * Jason: *"if I stay on the menu screen for a long time, the plane keeps
 * defaulting to flying higher and higher."* Measured before the fix, over half
 * an hour of simulated flight against a 450 m target: the trainer reached
 * 1,677 m, the jet 4,907 m and the Global 8000 **9,760 m** — 32,000 ft, its
 * service ceiling. It was not drifting; Scenic's neutral commands 2.5 degrees
 * nose-up and nothing was telling it to stop.
 *
 * These tests pin the law. The end-to-end evidence is
 * `scripts/attract-hold-probe.mts`, which flies this same module.
 */

const BASE: AttractHoldInput = Object.freeze({
  clearance: 450,
  targetClearance: 450,
  requiredClimbRate: -5,
  requiredClimbRateLeft: -5,
  requiredClimbRateRight: -5,
  verticalSpeed: 0,
  groundSpeed: 47,
  equivalentAirspeed: 56,
  targetAirspeed: 56,
  stallSpeed: 22.2,
  dt: 1 / 120,
});

function out(): { pitch: number; roll: number; throttle: number } {
  return { pitch: 0, roll: 0, throttle: 0 };
}

describe("the attract hold", () => {
  it("asks for nose-down when it is above its target, which is the whole bug", () => {
    // Scenic's neutral is +2.5 degrees, so "no command" means "climb". Anything
    // that leaves pitch at 0 here has not fixed anything.
    const hold = new AttractHold(0.68);
    const o = out();
    hold.update({ ...BASE, clearance: 900, verticalSpeed: 1.5 }, o);
    expect(o.pitch).toBeLessThan(0);
  });

  it("finds a trim it was never told, and holds it", () => {
    // The integrator is the design: measured level-flight attitude is +0.25 deg
    // for the trainer, -2.50 for the jet and -0.75 for the bizjet at cruise
    // throttle, so no constant could serve all three (and two more aircraft are
    // coming). Fly a toy aeroplane whose level attitude is an arbitrary offset
    // and check the loop converges on it from either side.
    for (const trimOffset of [-0.4, -0.1, 0.25]) {
      const hold = new AttractHold(0.68);
      const o = out();
      let verticalSpeed = 0;
      for (let step = 0; step < 120 * 400; step += 1) {
        hold.update({ ...BASE, clearance: 450, verticalSpeed }, o);
        // Toy plant: vertical speed chases the commanded pitch about a trim the
        // controller has no way of knowing.
        verticalSpeed += ((o.pitch - trimOffset) * 14 - verticalSpeed) * 0.02;
      }
      expect(Math.abs(verticalSpeed), `trim ${trimOffset}`).toBeLessThan(0.25);
      expect(o.pitch).toBeCloseTo(trimOffset, 1);
    }
  });

  it("lets airspeed outrank altitude, so it cannot stall trying to hold height", () => {
    const hold = new AttractHold(0.68);
    const o = out();
    // 1,000 m below target — the altitude loop wants everything it can get —
    // but the aeroplane is below its speed floor.
    hold.update(
      { ...BASE, clearance: 0, targetClearance: 1_000, equivalentAirspeed: 22, verticalSpeed: -1 },
      o,
    );
    expect(o.pitch).toBeLessThan(0);
    expect(o.throttle).toBeGreaterThan(0.68);
  });

  it("moves the throttle too slowly to be heard hunting", () => {
    const hold = new AttractHold(0.5);
    const o = out();
    const before = { value: 0.5 };
    let worstStep = 0;
    for (let step = 0; step < 120 * 20; step += 1) {
      hold.update({ ...BASE, equivalentAirspeed: 20, dt: 1 / 120 }, o);
      worstStep = Math.max(worstStep, Math.abs(o.throttle - before.value) * 120);
      before.value = o.throttle;
    }
    // Per second, not per step: a tenth of travel a second at the very most.
    expect(worstStep).toBeLessThan(0.1);
  });

  it("turns away only from terrain it cannot out-climb, and commits once it does", () => {
    const hold = new AttractHold(0.68);
    const o = out();
    // Gentle rise: climb, do not turn.
    hold.update({ ...BASE, requiredClimbRate: 1 }, o);
    expect(hold.isTurning).toBe(false);
    expect(o.roll).toBe(0);
    // A wall: turn, toward the lower side.
    hold.update(
      { ...BASE, requiredClimbRate: 40, requiredClimbRateLeft: 30, requiredClimbRateRight: 8 },
      o,
    );
    expect(hold.isTurning).toBe(true);
    expect(o.roll).toBeGreaterThan(0);
    // Hysteresis: a marginal improvement does not release it, so it cannot
    // dither from side to side along a ridge line.
    hold.update({ ...BASE, requiredClimbRate: attractAchievableClimbRate() - 0.1 }, o);
    expect(hold.isTurning).toBe(true);
    // Properly clear: roll out.
    hold.update({ ...BASE, requiredClimbRate: -10 }, o);
    expect(hold.isTurning).toBe(false);
    expect(o.roll).toBe(0);
  });

  it("will not turn on a look-ahead that means nothing", () => {
    const hold = new AttractHold(0.68);
    const o = out();
    hold.update({ ...BASE, groundSpeed: 2, requiredClimbRate: 99 }, o);
    expect(hold.isTurning).toBe(false);
  });
});

describe("the numbers that must scale with the aeroplane, not with the trainer", () => {
  it("commands a standard-rate turn at every speed rather than a fixed bank", () => {
    // Measured: an 18 degree bank turns the trainer at 3.9 deg/s but the Global
    // at 0.87 deg/s, which needs 21 km to turn 90 degrees. A fixed bank is a
    // constant tuned against one aeroplane; a rate is not.
    const rateAt = (speed: number): number => {
      const bank = attractTurnRoll(speed, 60) * (42 * Math.PI) / 180;
      return (9.80665 * Math.tan(bank)) / speed;
    };
    // Exact wherever Scenic's 42 degrees of authority can deliver it.
    for (const speed of [47, 100, 155, 168]) {
      expect(rateAt(speed), `${speed} m/s`).toBeCloseTo(ATTRACT_TURN_RATE_RADIANS_PER_SECOND, 3);
    }
    // Above 168.6 m/s the bank saturates at Scenic's 42 degrees -- its limit,
    // not this function's. The Global turns at 2.4 deg/s instead of 3, which is
    // still nearly three times the rate a fixed 18 degree bank gave it.
    const fast = rateAt(210) * 180 / Math.PI;
    expect(fast).toBeGreaterThan(2.3);
    expect(fast).toBeLessThan(3.1);
    const fixedEighteenDegrees = (9.80665 * Math.tan(18 * Math.PI / 180)) / 210 * 180 / Math.PI;
    expect(fast).toBeGreaterThan(fixedEighteenDegrees * 2.5);
    // And it stays inside what Scenic will accept.
    expect(attractTurnRoll(260, 90)).toBeLessThanOrEqual(1);
    expect(attractTurnRoll(1, 30)).toBeGreaterThan(0);
  });

  it("floors the clearance in SECONDS, so a fast aeroplane gets more height", () => {
    const hold = new AttractHold(0.6);
    const o = out();
    // The trainer's floor is under the 450 m default, so the player's setting
    // stands and this must not raise it.
    expect(47 * ATTRACT_MIN_CLEARANCE_SECONDS).toBeLessThan(450);
    hold.update({ ...BASE, clearance: 450, groundSpeed: 47 }, o);
    const trainerDemand = o.pitch;
    // The Global's is well above it, so at 450 m it should be climbing hard.
    const fast = new AttractHold(0.6);
    const o2 = out();
    fast.update({ ...BASE, clearance: 450, groundSpeed: 210, equivalentAirspeed: 210, targetAirspeed: 210, stallSpeed: 69.5 }, o2);
    expect(o2.pitch).toBeGreaterThan(trainerDemand);
  });

  it("keeps the same look-ahead in SECONDS at every speed", () => {
    // 6 km was the mistake: two minutes of warning for the trainer, thirty-nine
    // seconds for the jet, of which the climb lag eats a quarter.
    for (const speed of [47, 155, 210]) {
      const seconds = attractScanDistance(speed) / speed;
      expect(seconds, `${speed} m/s`).toBeGreaterThanOrEqual(ATTRACT_SCAN_SECONDS * 0.99);
    }
    expect(attractScanDistance(500)).toBe(ATTRACT_SCAN_MAX_METERS);
  });
});

describe("the terrain scan's geometry", () => {
  it("samples densely near the aeroplane and sparsely at the horizon", () => {
    // Even spacing stepped straight over ridge crests: traced, the scan reported
    // a peak of 277 m ahead while the ground directly beneath was already 316 m.
    const distance = 5_000;
    const samples = attractScanSamples(distance);
    const offsets = Array.from({ length: samples }, (_, i) => attractScanOffset(i + 1, samples, distance));
    expect(offsets[0]).toBeLessThan(100);
    expect(offsets[offsets.length - 1]).toBeCloseTo(distance, 6);
    for (let i = 1; i < offsets.length; i += 1) {
      expect(offsets[i]!).toBeGreaterThan(offsets[i - 1]!);
    }
    const firstGap = offsets[1]! - offsets[0]!;
    const lastGap = offsets[offsets.length - 1]! - offsets[offsets.length - 2]!;
    expect(firstGap).toBeLessThan(lastGap / 4);
  });

  it("asks more of closer terrain at the same height", () => {
    // The bug this replaced: a max over HEIGHTS forgets the distance that made
    // each height reachable or not.
    const near = attractClimbRateFor(1_000, 500, 900, 47);
    const far = attractClimbRateFor(1_000, 5_000, 900, 47);
    expect(near).toBeGreaterThan(far);
    // Ground below the aeroplane demands nothing.
    expect(attractClimbRateFor(100, 3_000, 900, 47)).toBeLessThan(0);
  });
});

describe("the re-seed, and where the supervisor is allowed to run", () => {
  it("keeps the old re-seed rule exactly", () => {
    expect(ATTRACT_RESEED_CLEARANCE_METERS).toBe(65);
    expect(shouldReseedAttract(false, 64)).toBe(true);
    expect(shouldReseedAttract(false, 66)).toBe(false);
    expect(shouldReseedAttract(true, 5_000)).toBe(true);
  });

  it("cannot touch player flight: every call site is under attractMode", () => {
    // The worker cannot be imported (it dereferences `self` at module scope and
    // starts a timer on load), so this reads it as text -- the same thing
    // tests/simulation-client.test.ts and the stability-augmentation test do.
    const source = readFileSync(
      new URL("../src/workers/simulation.worker.ts", import.meta.url),
      "utf8",
    );
    // Scenic receives the supervisor's controls ONLY in attract; a player's own
    // controls are what it sees otherwise. (The expression moved out of the
    // call when Scenic grew its own height hold, which is exactly the kind of
    // edit this assertion exists to make somebody look at.)
    expect(source).toContain("let requestedControls = attractMode ? attractControls : controls;");
    // And the two holds never run together: the menu flight carries a complete
    // supervisor of its own, so layering Scenic's hold beneath it would be two
    // controllers arguing over one elevator.
    expect(source).toContain('if (!attractMode && selectedMode === "scenic")');
    // The one place they DO touch is the hand-off, where the pilot's hold takes
    // the trim the menu flight already learned instead of starting from zero.
    // It lives in the `handoff` branch and nowhere else, because anywhere else
    // would be the two holds running at once.
    expect(source).toContain("scenicAltitudeHold.adopt(attractHold.verticalTrim)");
    expect(source.match(/scenicAltitudeHold\.adopt\(/g)).toHaveLength(1);
    // The supervisor runs from exactly one place, and that place is guarded.
    expect(source).toContain("if (attractMode) updateAttractSupervisor();");
    expect(source.match(/updateAttractSupervisor\(\)/g)).toHaveLength(2);
    // And the re-seed decision comes from the shared module rather than a
    // second copy of the rule.
    expect(source).toContain("shouldReseedAttract(simulator.state.crashed");
    expect(source).not.toContain("demoState.altitudeAgl < 65");
  });
});

describe("the scan looks where the aeroplane is actually going", () => {
  // THE GATE FOR THE THIRD UNITS ERROR OF THE WAVE (metres for feet, feet for
  // metres, and then degrees for radians). `telemetry.heading` is radians; the
  // scan treated it as degrees and pointed 57 times too close to north, which
  // caused every terrain symptom this controller appeared to have. A unit test
  // on the conversion alone would not have caught it -- the conversion looked
  // reasonable. What catches it is comparing the direction against the
  // aeroplane's OWN ground track, which no amount of consistent wrongness can
  // fake.
  const environment = {
    terrain: () => ({ height: 0, friction: 0.86 }),
    terrainHeight: () => 0,
    seaLevel: 0,
  };

  it("agrees with a flying aeroplane's ground track in all four quadrants", () => {
    for (const degrees of [30, 120, 210, 300]) {
      const heading = (degrees * Math.PI) / 180;
      const simulator = new FlightSimulator({
        aircraft: aircraftDefinition("trainer"),
        spawn: { position: { x: 0, y: 1_200, z: 0 }, airspeed: 50, heading },
        environment,
      });
      for (let step = 0; step < 120; step += 1) simulator.step(1 / 120);
      const telemetry = simulator.telemetry();
      const [trackX, trackZ] = attractTrackVector(telemetry.heading);
      const { x, z } = simulator.state.velocity;
      const speed = Math.hypot(x, z);
      expect(speed, `${degrees} deg: not moving`).toBeGreaterThan(20);
      // The scan direction and the real ground track must be the same ray.
      expect(trackX, `${degrees} deg track x`).toBeCloseTo(x / speed, 2);
      expect(trackZ, `${degrees} deg track z`).toBeCloseTo(z / speed, 2);
    }
  });

  it("sees a wall placed on the true track, and not one placed off it", () => {
    // A synthetic world: flat at sea level except a wall 2 km from the origin
    // along a chosen bearing. Scan from the origin on that bearing and on the
    // opposite one, exactly as the worker does, and check which one finds it.
    const WALL_DISTANCE = 2_000;
    const WALL_HALF_WIDTH = 400;
    const WALL_HEIGHT = 1_500;
    const altitude = 900;
    const groundSpeed = 47;

    const scanOn = (heading: number, wallBearing: number): number => {
      const wallX = Math.sin(wallBearing) * WALL_DISTANCE;
      const wallZ = Math.cos(wallBearing) * WALL_DISTANCE;
      const heightAt = (x: number, z: number): number =>
        Math.hypot(x - wallX, z - wallZ) < WALL_HALF_WIDTH ? WALL_HEIGHT : 0;
      const [hx, hz] = attractTrackVector(heading);
      const distance = attractScanDistance(groundSpeed);
      const samples = attractScanSamples(distance);
      let steepest = -Infinity;
      for (let i = 1; i <= samples; i += 1) {
        const along = attractScanOffset(i, samples, distance);
        steepest = Math.max(
          steepest,
          attractClimbRateFor(heightAt(hx * along, hz * along), along, altitude, groundSpeed),
        );
      }
      return steepest;
    };

    for (const degrees of [30, 120, 210, 300]) {
      const bearing = (degrees * Math.PI) / 180;
      // Flying AT the wall: it demands a climb nothing can deliver.
      expect(scanOn(bearing, bearing), `${degrees} deg, at the wall`)
        .toBeGreaterThan(attractAchievableClimbRate());
      // Flying away from it: nothing to see.
      const away = bearing + Math.PI;
      expect(scanOn(away, bearing), `${degrees} deg, away from the wall`)
        .toBeLessThan(0);
    }
  });

  it("would have failed with the units bug in it", () => {
    // The exact defect, reconstructed: treat the radian heading as degrees.
    const heading = (45 * Math.PI) / 180;
    const wrong = [Math.sin(heading * (Math.PI / 180)), Math.cos(heading * (Math.PI / 180))];
    const right = attractTrackVector(heading);
    // 45 degrees of track read as 0.45 degrees: almost due north.
    expect(wrong[0]!).toBeLessThan(0.02);
    expect(right[0]!).toBeCloseTo(Math.SQRT1_2, 6);
  });
});
