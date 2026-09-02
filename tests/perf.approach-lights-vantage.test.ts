import { describe, expect, it } from "vitest";
import { createWorld, sampleTerrain } from "../src/world";
import {
  PERF_CAPTURE_HEIGHT,
  PERF_CAPTURE_SEED,
  PERF_CAPTURE_SHOTS,
  PERF_CAPTURE_WIDTH,
  headingVectorFromYaw,
} from "../scripts/perf-capture.mts";
import { airfieldFixtures } from "../src/render/webgpu/lighting/AirfieldLighting";

/**
 * **`approach-lights-outboard` is valid only while the runway points where this
 * shot looks, and that is a property of the capture SEED.**
 *
 * The shot declares no `relativeSunBearingDegrees`, so the harness flies it at
 * yaw 0 — body +x. It frames the approach lighting system only because the
 * capture world's runway happens to lie within about a degree of +x. **On a
 * different seed the runway points elsewhere and this shot frames open
 * terrain.** Every airport shot shares that coupling; this one is singled out
 * because its entire value is that it frames one specific 400 m of ground, so
 * **it degrades to NOTHING rather than to something slightly off** — the case
 * where silent degradation is worst.
 *
 * So the assertion is not "the heading is about right". It is the thing the
 * shot exists for: **the lamps are in the frustum**, computed from the shipping
 * lamp positions and the shipping shot definition, with the heading reported in
 * the failure so a seed change reads as a seed change rather than a mystery.
 */

const HORIZONTAL_FOV_DEGREES = 56;

describe("approach-lights-outboard frames the approach lighting system", () => {
  it("puts every near-end approach lamp inside the frustum", () => {
    const shot = PERF_CAPTURE_SHOTS.find((s) => s.name === "approach-lights-outboard");
    expect(shot, "the shot has been renamed or removed").toBeDefined();
    // Yaw comes from the sun bearing when a shot declares one; this shot must
    // not, or the camera swings with the clock and the framing is no longer
    // what was measured.
    expect(
      shot!.relativeSunBearingDegrees,
      "this shot must fly yaw 0; a sun bearing would swing the camera off the runway",
    ).toBeUndefined();

    const world = createWorld(PERF_CAPTURE_SEED);
    const airport = world.airport;
    expect(airport, "the capture world has no airport").toBeDefined();

    const camX = airport!.centerX + shot!.offsetXMeters;
    const camZ = airport!.centerZ + shot!.offsetZMeters;
    const camY = sampleTerrain(world, camX, camZ).height + shot!.altitudeAglMeters!;
    const forward = headingVectorFromYaw(0);
    const right = { x: -forward.z, z: forward.x };

    const halfHorizontal = Math.tan((HORIZONTAL_FOV_DEGREES * Math.PI) / 360);
    const halfVerticalDegrees =
      (Math.atan(halfHorizontal * (PERF_CAPTURE_HEIGHT / PERF_CAPTURE_WIDTH)) * 180) / Math.PI;

    const lamps = airfieldFixtures(airport!)
      .filter((f) => f.kind === "approach" && f.along < 0);
    // NON-VACUITY: an empty lamp set would pass every assertion below by having
    // nothing to check, which is how a framing guard silently stops guarding.
    expect(lamps.length, "no near-end approach lamps to frame").toBe(16);

    const outside: string[] = [];
    for (const lamp of lamps) {
      const dx = lamp.x - camX;
      const dz = lamp.z - camZ;
      const horizontal = Math.hypot(dx, dz);
      const ahead = dx * forward.x + dz * forward.z;
      const lateral = dx * right.x + dz * right.z;
      const bearing = (Math.atan2(lateral, ahead) * 180) / Math.PI;
      const depression = (-Math.atan2(lamp.y - camY, horizontal) * 180) / Math.PI;
      const inHorizontal = ahead > 0 && Math.abs(bearing) <= HORIZONTAL_FOV_DEGREES / 2;
      const inVertical =
        depression >= shot!.pitchDownDegrees - halfVerticalDegrees
        && depression <= shot!.pitchDownDegrees + halfVerticalDegrees;
      if (!inHorizontal || !inVertical) {
        outside.push(`along ${lamp.along.toFixed(0)} bearing ${bearing.toFixed(1)}deg `
          + `depression ${depression.toFixed(1)}deg range ${horizontal.toFixed(0)}m`);
      }
    }

    // IN THE FRUSTUM IS NOT ENOUGH, and the first version of this guard only
    // checked that. Moved from -1500 to -3000 m the lamps stay inside the
    // frustum - at 1.9 km they sit 1.8 deg below the horizon, comfortably
    // within a 16.6 deg half-FOV - and the guard passed while the shot showed
    // nothing usable. The shot exists to show TREES STANDING IN LAMPS, so the
    // binding requirement is angular size, not membership.
    //
    // A dominant crown is 5.8 m across the radius; at 1280 px over 56 deg the
    // frame resolves 22.9 px/deg, so a crown at range R spans 2*5.8/R radians
    // = 266/R px. At 800 m that is 8 px, which is the floor at which a tree
    // beside a lamp is a tree rather than a smudge. The crossbar is the element
    // this shot is for, so the bound is asserted on the crossbar.
    const crossbar = lamps.filter((l) => Math.abs(l.along) === 960);
    expect(crossbar.length, "the crossbar is not where this guard expects it").toBe(10);
    const crossbarRange = Math.max(...crossbar.map((l) => Math.hypot(l.x - camX, l.z - camZ)));
    expect(
      crossbarRange,
      `the crossbar is ${crossbarRange.toFixed(0)} m away. Beyond 800 m a dominant crown spans `
      + "fewer than 8 px and a tree standing in a lamp cannot be told from a smudge, so the shot "
      + "would frame the system without being able to show the defect.",
    ).toBeLessThanOrEqual(800);

    const runwayHeadingDegrees = (airport!.headingRadians * 180) / Math.PI;
    expect(
      outside,
      `${outside.length} of ${lamps.length} approach lamps are outside the frame. `
      + `The capture world's runway heading is ${runwayHeadingDegrees.toFixed(1)} deg and this shot `
      + "flies yaw 0, so the seed has almost certainly moved: this vantage is only valid while the "
      + `runway lies near body +x. Outside: ${outside.join("; ")}`,
    ).toEqual([]);
  });
});
