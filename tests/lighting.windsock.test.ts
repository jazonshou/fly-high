import { describe, expect, it } from "vitest";
import { createWorld, sampleWind } from "../src/world";
import {
  WINDSOCK_FULL_EXTENSION_MPS,
  WINDSOCK_MINIMUM_INDICATION_MPS,
  WINDSOCK_SLACK_DROOP_RADIANS,
  headingDifferenceRadians,
  runwayAxisDifferenceRadians,
  windsockDroopRadians,
  windsockHeadingRadians,
  windsockInflation,
  windsockWorldPosition,
} from "../src/render/webgpu/detail/AirfieldFurniture";

/**
 * `7-13` windsock — the two assertions that are not satisfied by a plausible
 * frame, plus the premise check that keeps them meaningful.
 *
 * **`createWorld` takes the seed POSITIONALLY**, and every call below passes it
 * that way. The object form is a **type error** (`WorldSeed = string | number`),
 * caught by `npm run typecheck` in CI, so a typed caller cannot reach it.
 *
 * CORRECTION, recorded because the first version of this docblock asserted the
 * opposite and I put it there: I "verified" the object form collapsing every
 * seed to `seedHash` 905055214 — and my probe used an `as any` cast to do it.
 * **The cast is what made it reachable.** I confirmed the MECHANISM and never
 * checked REACHABILITY, then reported it as a live hazard. So did the message I
 * was checking. Two of us validated a trap that typed code cannot hit.
 *
 * The residue is real but narrow, and worth knowing for anything outside the
 * typechecker: a `.mts` script, a worker payload or an `as any` still reaches
 * it, and the failure is worse than a collision between object seeds —
 * `hashSeed` iterates `text.length`, an object has none, so it returns the
 * untouched FNV basis and collides with the EMPTY-STRING hash. `normalizeSeed`
 * now throws a `TypeError` naming that.
 */

/**
 * The crosswind validation seed. Measured by `SWE II 2` across 12 seeds: the
 * runway-to-wind axis difference ranges from 2.7 degrees (`sock-1`) to 85.9
 * (`hangar-a`), with 5 of 12 inside 30 degrees.
 */
const CROSSWIND_SEED = "hangar-a";

/** Below this the seed is too aligned to distinguish a sock from a runway. */
const CROSSWIND_THRESHOLD_RADIANS = (45 * Math.PI) / 180;

function airportFor(seed: string) {
  const world = createWorld(seed);
  const airport = world.airport;
  if (!airport) throw new Error(`seed ${seed} has no airport`);
  return { world, airport };
}

describe("the validation seed is still a crosswind seed", () => {
  it("has a runway axis well away from the prevailing wind", () => {
    // THIS IS A PREMISE CHECK, NOT A FEATURE CHECK, and the distinction is the
    // point of it.
    //
    // The runway's preferred heading and the prevailing wind come from the SAME
    // expression — `unitFloatFromHash(mixSeed(h, 301)) * 2pi` — and the site
    // scorer adds a 4x wind-axis penalty, so a sock aligned with the runway is
    // the common case. But the two are called with DIFFERENT hashes (heading
    // from `sourceSeedHash`, wind from `seedHash`, which the guaranteed-airport
    // search replaces), so the alignment is SEED-DEPENDENT rather than
    // structural.
    //
    // That is what makes this fragile in a way a normal fixture is not: nothing
    // stops a later change to seeding, the footprint or the region catalogue
    // from quietly turning `hangar-a` into a 5-degree seed. The windsock tests
    // below would still PASS, and would have silently become the blind case —
    // a sock reading the runway heading is indistinguishable from a sock
    // reading the wind when the two agree.
    const { world, airport } = airportFor(CROSSWIND_SEED);
    const difference = runwayAxisDifferenceRadians(
      airport.headingRadians,
      world.prevailingWindRadians,
    );
    expect(
      difference,
      `THE VALIDATION SEED HAS STOPPED BEING VALID — not the windsock. `
      + `"${CROSSWIND_SEED}" now puts the runway ${(difference * 180 / Math.PI).toFixed(1)}deg `
      + `from the prevailing wind, under the ${(CROSSWIND_THRESHOLD_RADIANS * 180 / Math.PI)}deg `
      + "this file needs to tell a wind-driven sock from a runway-aligned one. "
      + "Re-measure the seed set and pick a new crosswind seed; do not widen this "
      + "threshold, which would make the tests below vacuous rather than fix them.",
    ).toBeGreaterThan(CROSSWIND_THRESHOLD_RADIANS);
  });

  it("is measurably different from an ALIGNED seed, so the axis means something", () => {
    // Non-vacuity: if every seed came back crosswind the check above would pass
    // without testing anything. `sock-1` was measured at 2.7 degrees.
    const aligned = airportFor("sock-1");
    const alignedDifference = runwayAxisDifferenceRadians(
      aligned.airport.headingRadians,
      aligned.world.prevailingWindRadians,
    );
    expect(alignedDifference).toBeLessThan(CROSSWIND_THRESHOLD_RADIANS);
  });
});

describe("the sock is driven by wind AT THE SOCK", () => {
  it("samples a wind that differs from the aircraft's", () => {
    // THE ASSERTION THAT TESTS THE TRAP. Pointing correctly is not the same as
    // being driven by a per-object sample: a sock reading the AIRCRAFT's wind
    // still points, still swings, still gusts, and no frame distinguishes it.
    // The renderer's only `sampleWind` consumer samples at the aircraft and
    // forwards four scalars, so this is the live failure mode rather than a
    // hypothetical one.
    const { world, airport } = airportFor(CROSSWIND_SEED);
    const sock = windsockWorldPosition(airport);
    // An aircraft on approach, 2.5 km out along the runway axis at 150 m.
    const aircraft = {
      x: airport.centerX - 2_500 * Math.sin(airport.headingRadians),
      y: airport.elevation + 150,
      z: airport.centerZ - 2_500 * Math.cos(airport.headingRadians),
    };
    const time = 137.5;
    const atSock = sampleWind(world, sock.x, sock.y, sock.z, time);
    const atAircraft = sampleWind(world, aircraft.x, aircraft.y, aircraft.z, time);

    const headingAtSock = windsockHeadingRadians(atSock.x, atSock.z);
    const headingAtAircraft = windsockHeadingRadians(atAircraft.x, atAircraft.z);
    const separation = headingDifferenceRadians(headingAtSock, headingAtAircraft);

    expect(
      separation,
      "the wind at the sock and the wind at the aircraft are indistinguishable "
      + "here, so this test cannot tell a per-object sample from the renderer's "
      + "shared one. Move the aircraft probe further from the sock or pick a "
      + "seed with more field variation — do not delete the assertion",
    ).toBeGreaterThan(1e-6);
    // And the speeds differ too, which is what drives inflation.
    expect(Math.abs(atSock.speed - atAircraft.speed)).toBeGreaterThan(1e-6);
  });

  it("points where the air is going, not where it came from", () => {
    // A sock 180 degrees out still looks like a windsock. The convention is
    // asserted against a wind blowing due east: the sock must read east.
    expect(windsockHeadingRadians(1, 0)).toBeCloseTo(Math.PI / 2, 9);
    expect(windsockHeadingRadians(0, 1)).toBeCloseTo(0, 9);
    expect(windsockHeadingRadians(-1, 0)).toBeCloseTo(-Math.PI / 2, 9);
    // Same convention as AirportDefinition.headingRadians, so the two are
    // directly comparable — which the premise check above relies on.
    const { airport } = airportFor(CROSSWIND_SEED);
    const axis = windsockHeadingRadians(
      Math.sin(airport.headingRadians),
      Math.cos(airport.headingRadians),
    );
    expect(headingDifferenceRadians(axis, airport.headingRadians)).toBeLessThan(1e-9);
  });

  it("stands clear of the runway and on the platform", () => {
    const { airport } = airportFor(CROSSWIND_SEED);
    const sock = windsockWorldPosition(airport);
    const dx = sock.x - airport.centerX;
    const dz = sock.z - airport.centerZ;
    const across = dx * Math.cos(airport.headingRadians) - dz * Math.sin(airport.headingRadians);
    expect(Math.abs(across)).toBeGreaterThan(airport.runwayWidth / 2 + airport.shoulderWidth);
    expect(sock.y).toBeGreaterThan(airport.elevation);
  });
});

describe("the sock reads as an instrument", () => {
  it("is limp below the indication minimum and extended above 15 kt", () => {
    expect(windsockInflation(0)).toBe(0);
    expect(windsockInflation(WINDSOCK_MINIMUM_INDICATION_MPS)).toBe(0);
    expect(windsockInflation(WINDSOCK_FULL_EXTENSION_MPS)).toBe(1);
    expect(windsockInflation(50)).toBe(1);
    expect(windsockDroopRadians(0)).toBeCloseTo(WINDSOCK_SLACK_DROOP_RADIANS, 9);
    expect(windsockDroopRadians(WINDSOCK_FULL_EXTENSION_MPS)).toBeCloseTo(0, 9);
  });

  it("is monotonic and linear between them, because a pilot reads speed off it", () => {
    // A curve here would make the instrument lie: the segments are calibrated,
    // so inflation must be proportional to speed across the indicating range.
    let previous = -1;
    for (let speed = 0; speed <= 12; speed += 0.05) {
      const inflation = windsockInflation(speed);
      expect(inflation).toBeGreaterThanOrEqual(previous);
      previous = inflation;
    }
    const mid = (WINDSOCK_MINIMUM_INDICATION_MPS + WINDSOCK_FULL_EXTENSION_MPS) / 2;
    expect(windsockInflation(mid)).toBeCloseTo(0.5, 9);
  });
});
