import { describe, expect, it } from "vitest";
import {
  AIRCRAFT_KINDS,
  AttractHold,
  DEFAULT_CONTROLS,
  FIXED_TIME_STEP,
  FlightSimulator,
  SCENIC_HOLD_DEADBAND,
  SCENIC_HOLD_HANDBACK_SECONDS,
  SCENIC_HOLD_MIN_CLEARANCE,
  ScenicAltitudeHold,
  VERTICAL_FLOOR_TRIM_BLEED,
  VERTICAL_SPEED_FLOOR,
  VerticalSpeedPitchTrim,
  aircraftDefinition,
  applyFlightAssistance,
  stallSpeed,
  type AircraftKind,
  type AttractHoldOutput,
  type EnvironmentInput,
  type FlightControls,
} from "../src/sim";
import { airborneAirspeedForAircraft, airborneThrottleForAircraft } from "../src/game/spawn";

/**
 * Scenic's centred stick holds height.
 *
 * Jason asked for this after the menu flight's climb was traced to the same
 * cause: `applyFlightAssistance` commands `2.5deg + stick * 14deg`, so letting
 * go of the stick in Scenic asked for 2.5 degrees nose-up, forever. His words:
 * *"Yes, hold height"*.
 *
 * Everything here is written KIND-AGNOSTIC over `AIRCRAFT_KINDS`, so the F-16
 * and 747-8 are tested by it the day they merge rather than the day someone
 * remembers. Every threshold is derived from the aeroplane's own numbers —
 * `stallSpeed()` and the catalogue's cruise — for the same reason.
 */

/** Flat ground far below, so nothing here is about terrain. */
const GROUND = 0;
const environment: EnvironmentInput = {
  terrain: () => ({ height: GROUND, friction: 0.86 }),
  terrainHeight: () => GROUND,
  seaLevel: GROUND,
};

interface FlightResult {
  readonly altitude: number;
  readonly verticalSpeed: number;
  readonly equivalentAirspeed: number;
  readonly minimumSpeedMargin: number;
  readonly maximumAltitude: number;
  readonly minimumAltitude: number;
}

/**
 * Flies one aeroplane through Scenic exactly as the worker does: the hold
 * writes the pitch axis, `applyFlightAssistance` flies it, nothing else moves.
 */
function fly(
  kind: AircraftKind,
  seconds: number,
  stickAt: (elapsed: number) => number,
  options: { readonly throttle?: number; readonly startAltitude?: number } = {},
): FlightResult {
  const aircraft = aircraftDefinition(kind);
  const startAltitude = options.startAltitude ?? 1_200;
  const throttle = options.throttle ?? airborneThrottleForAircraft(kind);
  const simulator = new FlightSimulator({
    aircraft,
    spawn: {
      position: { x: 0, y: startAltitude, z: 0 },
      airspeed: airborneAirspeedForAircraft(kind),
    },
    controls: { throttle },
    environment,
  });
  const hold = new ScenicAltitudeHold();
  const requested: FlightControls = { ...DEFAULT_CONTROLS, throttle };
  const assisted: FlightControls = { ...DEFAULT_CONTROLS };
  let minimumSpeedMargin = Infinity;
  let maximumAltitude = -Infinity;
  let minimumAltitude = Infinity;

  const steps = Math.round(seconds / FIXED_TIME_STEP);
  for (let step = 0; step < steps; step += 1) {
    const telemetry = simulator.telemetry();
    const stick = stickAt(step * FIXED_TIME_STEP);
    requested.throttle = throttle;
    requested.pitch = hold.update({
      pitchStick: stick,
      onGround: simulator.state.onGround,
      clearance: telemetry.altitudeAgl,
      altitude: simulator.state.position.y,
      verticalSpeed: telemetry.verticalSpeed,
      equivalentAirspeed: telemetry.indicatedAirspeed,
      stallSpeed: stallSpeed(aircraft, simulator.state.actuators.flaps),
      dt: FIXED_TIME_STEP,
    });
    simulator.setControls(
      applyFlightAssistance(assisted, "scenic", requested, simulator.state, telemetry),
    );
    simulator.step(FIXED_TIME_STEP);
    const after = simulator.telemetry();
    minimumSpeedMargin = Math.min(
      minimumSpeedMargin,
      after.indicatedAirspeed / stallSpeed(aircraft, simulator.state.actuators.flaps),
    );
    maximumAltitude = Math.max(maximumAltitude, simulator.state.position.y);
    minimumAltitude = Math.min(minimumAltitude, simulator.state.position.y);
  }
  const final = simulator.telemetry();
  return {
    altitude: simulator.state.position.y,
    verticalSpeed: final.verticalSpeed,
    equivalentAirspeed: final.indicatedAirspeed,
    minimumSpeedMargin,
    maximumAltitude,
    minimumAltitude,
  };
}

describe.each(AIRCRAFT_KINDS)("Scenic hands-off in the %s", (kind) => {
  it("neither climbs nor descends", () => {
    // The whole request, in one assertion: hands off means level.
    const result = fly(kind, 60, () => 0);
    expect(Math.abs(result.verticalSpeed)).toBeLessThan(0.5);
  });

  it("settles quickly and then does not drift over five minutes", () => {
    const settle = fly(kind, 20, () => 0);
    expect(Math.abs(settle.verticalSpeed), "settled within 20 s").toBeLessThan(0.5);
    const long = fly(kind, 300, () => 0);
    // Drift is measured against where it STARTED, over the whole five minutes.
    expect(Math.abs(long.altitude - 1_200), "drift over 5 min").toBeLessThan(15);
    expect(long.maximumAltitude - long.minimumAltitude, "excursion over 5 min")
      .toBeLessThan(40);
  });

  it("levels off where the climb ended, and does not fly back down", () => {
    // Pull for 20 s, release, and let it settle. The aeroplane must stay up
    // where it got to -- "let go" does not mean "undo".
    const climbSeconds = 20;
    const result = fly(kind, climbSeconds + 90, (t) => (t < climbSeconds ? 0.5 : 0));
    expect(result.altitude, "ended above where it started").toBeGreaterThan(1_200 + 20);
    expect(Math.abs(result.verticalSpeed), "levelled off").toBeLessThan(0.6);
    // It may coast up a little after release; it must not sag back toward the
    // height it left. The floor is generous, the point is the DIRECTION.
    expect(result.altitude).toBeGreaterThan(result.maximumAltitude - 120);
    expect(result.minimumAltitude).toBeGreaterThan(1_190);
  });

  it("pushes over and levels off lower, symmetrically", () => {
    const result = fly(kind, 110, (t) => (t < 20 ? -0.5 : 0));
    expect(result.altitude).toBeLessThan(1_200 - 20);
    expect(Math.abs(result.verticalSpeed)).toBeLessThan(0.6);
  });

  it("gives up height rather than airspeed at idle", () => {
    // Hands off with the engine at idle must end in a stable descent, never a
    // mush. The margin is over the aeroplane's OWN stall speed.
    const result = fly(kind, 180, () => 0, { throttle: 0, startAltitude: 3_000 });
    expect(result.minimumSpeedMargin, "never slower than 1.1x stall").toBeGreaterThan(1.1);
    expect(result.altitude, "descended").toBeLessThan(3_000);
    expect(result.verticalSpeed, "descending, not falling").toBeGreaterThan(-25);
  });
});

describe("the hold stays out of the way where it should", () => {
  it("passes the stick through untouched on the ground and through rotation", () => {
    // A runway start must rotate exactly as it did before this existed, so on
    // the ground and below the engagement height the hold is the identity.
    const hold = new ScenicAltitudeHold();
    const base = {
      altitude: 100,
      verticalSpeed: 0,
      equivalentAirspeed: 40,
      stallSpeed: 22,
      dt: FIXED_TIME_STEP,
    };
    for (const stick of [-1, -0.4, 0, 0.4, 1]) {
      expect(hold.update({ ...base, pitchStick: stick, onGround: true, clearance: 0 }))
        .toBe(stick);
      expect(hold.update({
        ...base,
        pitchStick: stick,
        onGround: false,
        clearance: SCENIC_HOLD_MIN_CLEARANCE - 1,
      })).toBe(stick);
      expect(hold.holdingAltitude).toBeNull();
    }
  });

  it("does not step when the stick leaves and returns to centre", () => {
    // Both sides of the deadband are the same expression, learnedTrim + stick,
    // which is what makes this true rather than a tuning coincidence.
    const hold = new ScenicAltitudeHold();
    const base = {
      onGround: false,
      clearance: 1_200,
      altitude: 1_200,
      verticalSpeed: 0,
      equivalentAirspeed: 56,
      stallSpeed: 22,
      dt: FIXED_TIME_STEP,
    };
    // Let it learn a trim against a persistent climb it is trying to cancel.
    for (let step = 0; step < 1_200; step += 1) {
      hold.update({ ...base, pitchStick: 0, verticalSpeed: 1.5 });
    }
    const centred = hold.update({ ...base, pitchStick: 0 });
    const nudged = hold.update({ ...base, pitchStick: SCENIC_HOLD_DEADBAND * 2 });
    // Crossing out of the deadband adds the stick and nothing else.
    expect(nudged - centred).toBeCloseTo(SCENIC_HOLD_DEADBAND * 2, 2);
    const backAgain = hold.update({ ...base, pitchStick: 0 });
    expect(backAgain).toBeCloseTo(centred, 2);
  });

  it("forgets a captured height once the pilot flies again", () => {
    const hold = new ScenicAltitudeHold();
    const base = {
      onGround: false,
      clearance: 1_200,
      altitude: 1_200,
      verticalSpeed: 0,
      equivalentAirspeed: 56,
      stallSpeed: 22,
      dt: FIXED_TIME_STEP,
    };
    for (let step = 0; step < 600; step += 1) hold.update({ ...base, pitchStick: 0 });
    expect(hold.holdingAltitude).not.toBeNull();
    hold.update({ ...base, pitchStick: 0.5 });
    expect(hold.holdingAltitude).toBeNull();
  });
});

/**
 * Continuity of the commanded pitch.
 *
 * Scenic is an attitude-command law: what the hold writes becomes
 * `2.5deg + pitch * 14deg` of commanded attitude, directly. So any place the
 * hold CHANGES ITS MIND about who is flying — the engagement height, the
 * speed floor, the wheels touching, the hand-off from the menu flight — is a
 * place the commanded attitude can step, and a step is felt as a twitch.
 *
 * These were all measured before they were fixed, with the commanded attitude
 * logged frame by frame over real flights; the numbers in the comments are
 * from those traces. 0.3 deg is the bar: below one frame of a normal control
 * movement, and roughly the smallest attitude change that reads as deliberate.
 */
const STEP_LIMIT_DEGREES = 0.3;
/** Scenic's own mapping from the pitch axis to commanded attitude. */
const asDegrees = (pitchCommand: number) => pitchCommand * 14;

describe("the commanded pitch never steps", () => {
  const airborne = {
    onGround: false,
    clearance: 1_200,
    altitude: 1_200,
    verticalSpeed: 0,
    equivalentAirspeed: 56,
    stallSpeed: 22,
    dt: FIXED_TIME_STEP,
    pitchStick: 0,
  };

  /** Runs the hold until it has learned a trim it would be painful to lose. */
  function trimmed(): ScenicAltitudeHold {
    const hold = new ScenicAltitudeHold();
    for (let step = 0; step < 1_200; step += 1) {
      hold.update({ ...airborne, verticalSpeed: 1.5 });
    }
    return hold;
  }

  it("engages once, above the threshold, and stays engaged", () => {
    const hold = new ScenicAltitudeHold();
    hold.update({ ...airborne, clearance: SCENIC_HOLD_MIN_CLEARANCE - 1 });
    expect(hold.isEngaged, "not before the threshold").toBe(false);
    hold.update({ ...airborne, clearance: SCENIC_HOLD_MIN_CLEARANCE + 1 });
    expect(hold.isEngaged, "engaged on first crossing").toBe(true);
  });

  it("does not hand back when the ground rises under the aeroplane", () => {
    // The measured failure: flying hands-off at 40 m over ridges crossed the
    // 30 m line 2-7 times a run, and each crossing threw away the learned trim
    // mid-air -- 2.5 deg on the trainer, 7.2 deg on the jet. The pilot had done
    // nothing. This is why the threshold is a latch and not a condition.
    const hold = trimmed();
    const above = hold.update({ ...airborne, clearance: SCENIC_HOLD_MIN_CLEARANCE + 0.1 });
    const below = hold.update({ ...airborne, clearance: SCENIC_HOLD_MIN_CLEARANCE - 0.1 });
    expect(Math.abs(asDegrees(above)), "a trim worth losing").toBeGreaterThan(1);
    expect(Math.abs(asDegrees(below - above))).toBeLessThan(STEP_LIMIT_DEGREES);
    expect(hold.isEngaged, "still engaged below the line").toBe(true);
  });

  it("hands the aeroplane back over a second when the wheels touch", () => {
    const hold = trimmed();
    const flying = hold.update({ ...airborne });
    expect(Math.abs(asDegrees(flying)), "a trim worth handing back").toBeGreaterThan(1);

    const onGround = { ...airborne, onGround: true, clearance: 0 };
    let previous = hold.update(onGround);
    expect(Math.abs(asDegrees(previous - flying)), "no step at the wheels")
      .toBeLessThan(STEP_LIMIT_DEGREES);

    let worst = 0;
    const rollSteps = Math.round((SCENIC_HOLD_HANDBACK_SECONDS + 0.5) / FIXED_TIME_STEP);
    for (let step = 0; step < rollSteps; step += 1) {
      const next = hold.update(onGround);
      worst = Math.max(worst, Math.abs(asDegrees(next - previous)));
      previous = next;
    }
    expect(worst, "no step during the roll").toBeLessThan(STEP_LIMIT_DEGREES);
    expect(previous, "fully handed back").toBe(0);
    expect(hold.isEngaged).toBe(false);
  });

  it("does not step when the stick crosses the deadband under a live correction", () => {
    // Measured in flight before the fix: 1.04deg on the trainer, 1.34deg on the
    // jet, 4.88deg on the bizjet -- every one of them at stick 0.025 exactly.
    // Two causes at the same boundary: the demand switched from the height
    // correction to the aeroplane's own vertical speed AT the deadband rather
    // than across it, and the centred branch ignored the stick that the
    // displaced branch honoured. The existing crossing test above misses both
    // because it crosses with the correction and the vertical speed both zero,
    // where the two demands happen to agree.
    const hold = new ScenicAltitudeHold();
    for (let step = 0; step < 1_200; step += 1) hold.update({ ...airborne });
    expect(hold.holdingAltitude, "captured a height to correct toward").not.toBeNull();

    // Sitting 40 m low and sinking, so the correction demand and the vertical
    // speed disagree -- which is the whole point.
    const low = { ...airborne, altitude: 1_160, verticalSpeed: -1.5 };
    let previous: number | null = null;
    let worst = 0;
    const sweep = 200;
    for (let step = 0; step <= sweep; step += 1) {
      const stick = SCENIC_HOLD_DEADBAND * 2 * (step / sweep);
      // The hold's own contribution, with the pilot's stick taken back out, so
      // the sweep itself is not counted as a step.
      const contribution = hold.update({ ...low, pitchStick: stick }) - stick;
      if (previous !== null) worst = Math.max(worst, Math.abs(asDegrees(contribution - previous)));
      previous = contribution;
    }
    expect(worst).toBeLessThan(STEP_LIMIT_DEGREES);
  });

  it("carries the hand-back through a bounce", () => {
    // A firm landing leaves the ground again below the engagement height. The
    // ramp has to survive that: ending it because the wheels came up would drop
    // whatever was left of it in one frame, which is the failure this whole
    // mechanism exists to prevent.
    const hold = trimmed();
    let previous = hold.update({ ...airborne });
    let worst = 0;

    const track = (next: number) => {
      worst = Math.max(worst, Math.abs(asDegrees(next - previous)));
      previous = next;
    };
    const onGround = { ...airborne, onGround: true, clearance: 0 };
    for (let step = 0; step < Math.round(0.3 / FIXED_TIME_STEP); step += 1) {
      track(hold.update(onGround));
    }
    // Off the runway again, still well below the engagement height.
    const bounced = { ...airborne, clearance: SCENIC_HOLD_MIN_CLEARANCE - 5 };
    for (let step = 0; step < Math.round(1.2 / FIXED_TIME_STEP); step += 1) {
      track(hold.update(bounced));
    }
    expect(worst, "no step across the bounce").toBeLessThan(STEP_LIMIT_DEGREES);
    expect(previous, "ramp still ran to completion").toBe(0);
    expect(hold.isEngaged, "and it did not re-engage below the threshold").toBe(false);
  });

  it("fades the speed floor in rather than switching it on", () => {
    // Measured before the fix: 11.9 deg on the trainer, 14.0 deg on the jet,
    // repeating every ~18 s through a hands-off idle glide, because crossing
    // the floor deleted the learned trim in a single frame.
    const stall = 22;
    const trim = new VerticalSpeedPitchTrim();
    const sinking = {
      desiredVerticalSpeed: 0,
      verticalSpeed: -2,
      stallSpeed: stall,
      dt: FIXED_TIME_STEP,
    };
    for (let step = 0; step < 2_000; step += 1) {
      trim.update({ ...sinking, equivalentAirspeed: stall * 2 });
    }
    expect(trim.learnedTrim, "a trim worth losing").toBeGreaterThan(0.1);

    // Walk the airspeed down through the floor and back up through it.
    const floor = stall * VERTICAL_SPEED_FLOOR;
    // Down through the floor to where `recovery` saturates, and back up. The
    // whole range matters: the boundary is where the old code stepped, and the
    // deep end is where the bleed is fastest.
    let previous: number | null = null;
    let worst = 0;
    const sweep = 1_200;
    for (let step = 0; step <= sweep * 2; step += 1) {
      const fromFloor = 1 - Math.abs(sweep - step) / sweep;
      const command = trim.update({ ...sinking, equivalentAirspeed: floor + 1 - 8 * fromFloor });
      if (previous !== null) worst = Math.max(worst, Math.abs(asDegrees(command - previous)));
      previous = command;
    }
    expect(worst).toBeLessThan(STEP_LIMIT_DEGREES);
  });

  it("cannot step while bleeding a trim away, whatever the trim", () => {
    // The bound, rather than one sampled flight: the bleed is exponential with
    // a 0.5 s time constant, so the most it can move a command in one frame is
    // the FULL-SCALE trim times (1 - exp(-dt / 0.5)). At 120 Hz that is 0.23deg
    // even for a trim pinned at the clamp, which is why the time constant is
    // safe rather than merely observed to be safe.
    const mostOfTheTrimPerFrame = 1 - Math.exp(-FIXED_TIME_STEP / VERTICAL_FLOOR_TRIM_BLEED);
    expect(asDegrees(mostOfTheTrimPerFrame)).toBeLessThan(STEP_LIMIT_DEGREES);
  });
});

describe.each(AIRCRAFT_KINDS)("the hand-off from the menu flight in the %s", (kind) => {
  it("carries the learned trim across, so nothing steps and nothing sags", () => {
    // `takeControl` swaps the menu flight's supervisor for the pilot's hold on
    // one frame, mid-cruise. Both run the same law over the same aeroplane, so
    // the trim is already known; re-learning it from zero would walk the whole
    // thing back into the commanded pitch over the next few seconds, which the
    // pilot would fly through as a sag and a recovery.
    const aircraft = aircraftDefinition(kind);
    const throttle = airborneThrottleForAircraft(kind);
    const simulator = new FlightSimulator({
      aircraft,
      spawn: { position: { x: 0, y: 1_200, z: 0 }, airspeed: airborneAirspeedForAircraft(kind) },
      controls: { throttle },
      environment,
    });
    const attract = new AttractHold(throttle);
    const output: AttractHoldOutput = { pitch: 0, roll: 0, throttle };
    const requested: FlightControls = { ...DEFAULT_CONTROLS, throttle };
    const assisted: FlightControls = { ...DEFAULT_CONTROLS };

    /** One frame of the menu flight over flat ground, as the worker drives it. */
    const menuFrame = () => {
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
          targetAirspeed: airborneAirspeedForAircraft(kind),
          stallSpeed: stallSpeed(aircraft, simulator.state.actuators.flaps),
          dt: FIXED_TIME_STEP,
        },
        output,
      );
      requested.pitch = output.pitch;
      requested.roll = output.roll;
      requested.throttle = output.throttle;
      simulator.setControls(
        applyFlightAssistance(assisted, "scenic", requested, simulator.state, telemetry),
      );
      simulator.step(FIXED_TIME_STEP);
      return output.pitch;
    };

    // Fly the menu until it has actually SETTLED, which is the state a player
    // presses the button in. Waiting for the condition rather than for a fixed
    // number of seconds is what keeps this honest for aeroplanes that take
    // longer to get there: attract holds `max(target, groundSpeed * 6)`, so a
    // fast aeroplane is still climbing after two minutes and a hand-off timed
    // by the clock would have measured continuity in the middle of a climb.
    let lastMenuPitch = 0;
    let settledSeconds = 0;
    const patience = Math.round(600 / FIXED_TIME_STEP);
    for (let step = 0; step < patience && settledSeconds < 5; step += 1) {
      lastMenuPitch = menuFrame();
      settledSeconds = Math.abs(simulator.telemetry().verticalSpeed) < 0.2
        ? settledSeconds + FIXED_TIME_STEP
        : 0;
    }
    expect(settledSeconds, "the menu flight settled").toBeGreaterThanOrEqual(5);
    expect(Math.abs(asDegrees(lastMenuPitch)), "and learned a trim doing it")
      .toBeGreaterThan(0.5);

    // The hand-off frame. Same aeroplane, same instant, hands off.
    const hold = new ScenicAltitudeHold();
    hold.adopt(attract.verticalTrim);
    expect(hold.isEngaged, "engaged, not waiting for a threshold at cruise").toBe(true);

    const telemetry = simulator.telemetry();
    const firstPilotPitch = hold.update({
      pitchStick: 0,
      onGround: simulator.state.onGround,
      clearance: telemetry.altitudeAgl,
      altitude: simulator.state.position.y,
      verticalSpeed: telemetry.verticalSpeed,
      equivalentAirspeed: telemetry.indicatedAirspeed,
      stallSpeed: stallSpeed(aircraft, simulator.state.actuators.flaps),
      dt: FIXED_TIME_STEP,
    });
    expect(
      Math.abs(asDegrees(firstPilotPitch - lastMenuPitch)),
      "commanded pitch continuous across the hand-off",
    ).toBeLessThan(STEP_LIMIT_DEGREES);

    // And it stays flown: twenty seconds hands-off after the hand-off, with the
    // vertical speed held where the menu flight left it.
    let worstVerticalSpeed = 0;
    for (let step = 0; step < Math.round(20 / FIXED_TIME_STEP); step += 1) {
      const frame = simulator.telemetry();
      requested.pitch = hold.update({
        pitchStick: 0,
        onGround: simulator.state.onGround,
        clearance: frame.altitudeAgl,
        altitude: simulator.state.position.y,
        verticalSpeed: frame.verticalSpeed,
        equivalentAirspeed: frame.indicatedAirspeed,
        stallSpeed: stallSpeed(aircraft, simulator.state.actuators.flaps),
        dt: FIXED_TIME_STEP,
      });
      requested.roll = 0;
      requested.throttle = throttle;
      simulator.setControls(
        applyFlightAssistance(assisted, "scenic", requested, simulator.state, frame),
      );
      simulator.step(FIXED_TIME_STEP);
      worstVerticalSpeed = Math.max(
        worstVerticalSpeed,
        Math.abs(simulator.telemetry().verticalSpeed),
      );
    }
    expect(worstVerticalSpeed, "no sag or balloon after the hand-off").toBeLessThan(0.5);
  });
});
